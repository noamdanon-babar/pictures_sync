import React, { useState, useEffect, useRef } from "react";
import { Upload, Tag, Trash2, Plus, X, Search, Image as ImageIcon, Loader2, Info, Download, Maximize2, CheckSquare, Square, Check, LayoutGrid, Grid3X3, Grid2X2, Files, Settings, Folder, FolderCheck, List, ArrowUpDown, ArrowUpAZ, ArrowDownAZ, Calendar, Hash, SortAsc, SortDesc, CheckCircle2, AlertCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import JSZip from "jszip";
import { v4 as uuidv4 } from "uuid";
import PhotoCard from "./PhotoCard";

// IndexedDB helpers for persisting directory handles
const DB_NAME = "PhotoSyncDB";
const STORE_NAME = "settings";
const HANDLE_KEY = "downloadDirectoryHandle";

async function getDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveHandle(handle: FileSystemDirectoryHandle | null) {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  if (handle) {
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
  } else {
    tx.objectStore(STORE_NAME).delete(HANDLE_KEY);
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, "readonly");
  const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

interface Folder {
  id: string;
  name: string;
  createdAt: string;
}

export interface Photo {
  id: string;
  filename: string;
  originalName: string;
  tags: string[];
  uploadDate: string;
  type?: "image" | "video";
  folderId?: string | null;
}

interface UploadTask {
  id: string;
  fileName: string;
  progress: number;
  status: 'uploading' | 'completed' | 'error';
  error?: string;
}

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [showProgressPanel, setShowProgressPanel] = useState(false);
  const [photoToDelete, setPhotoToDelete] = useState<string | null>(null);
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const [showBatchTagModal, setShowBatchTagModal] = useState(false);
  const [batchTagsInput, setBatchTagsInput] = useState("");
  const [isDeletingBatch, setIsDeletingBatch] = useState(false);
  const [isApplyingBatchTags, setIsApplyingBatchTags] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [uploadsDir, setUploadsDir] = useState<string>("");
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([]);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [gridSize, setGridSize] = useState<"sm" | "md" | "lg" | "list">("list");
  const [sortBy, setSortBy] = useState<"name" | "date" | "tag">("date");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [directoryHandle, setDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [dirPermissionStatus, setDirPermissionStatus] = useState<PermissionState | "prompt">("prompt");
  const [showSettings, setShowSettings] = useState(false);
  const [newUploadsDir, setNewUploadsDir] = useState("");
  const [isUpdatingUploadsDir, setIsUpdatingUploadsDir] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [showMoveToFolderModal, setShowMoveToFolderModal] = useState(false);
  const [isMovingPhotos, setIsMovingPhotos] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchPhotos();
    fetchFolders();
    fetchConfig();
    initDirectoryHandle();
  }, []);

  const fetchFolders = async () => {
    try {
      const response = await fetch("/api/folders");
      const data = await response.json();
      setFolders(data);
    } catch (error) {
      console.error("Failed to fetch folders:", error);
    }
  };

  const initDirectoryHandle = async () => {
    if (!("showDirectoryPicker" in window)) return;
    try {
      const handle = await loadHandle();
      if (handle) {
        setDirectoryHandle(handle);
        const status = await (handle as any).queryPermission({ mode: "readwrite" });
        setDirPermissionStatus(status);
      }
    } catch (error) {
      console.error("Failed to load directory handle:", error);
    }
  };

  const handleSelectDirectory = async () => {
    try {
      const handle = await (window as any).showDirectoryPicker({
        mode: "readwrite"
      });
      await saveHandle(handle);
      setDirectoryHandle(handle);
      setDirPermissionStatus("granted");
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error("Failed to select directory:", error);
      }
    }
  };

  const requestDirPermission = async () => {
    if (!directoryHandle) return;
    try {
      const status = await (directoryHandle as any).requestPermission({ mode: "readwrite" });
      setDirPermissionStatus(status);
      return status === "granted";
    } catch (error) {
      console.error("Failed to request permission:", error);
      return false;
    }
  };

  const clearDirectory = async () => {
    await saveHandle(null);
    setDirectoryHandle(null);
    setDirPermissionStatus("prompt");
  };

  const saveFileToDirectory = async (filename: string, blob: Blob) => {
    if (!directoryHandle) return false;

    let hasPermission = dirPermissionStatus === "granted";
    if (!hasPermission) {
      hasPermission = await requestDirPermission() || false;
    }

    if (!hasPermission) return false;

    try {
      const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      console.error("Failed to save file to directory:", error);
      return false;
    }
  };

  const fetchConfig = async () => {
    try {
      const response = await fetch("/api/config");
      const data = await response.json();
      setUploadsDir(data.uploadsDir);
      setNewUploadsDir(data.uploadsDir);
    } catch (error) {
      console.error("Failed to fetch config:", error);
    }
  };

  const handleUpdateUploadsDir = async () => {
    if (!newUploadsDir.trim()) return;
    setIsUpdatingUploadsDir(true);
    try {
      const response = await fetch("/api/config/uploads-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadsDir: newUploadsDir.trim() }),
      });
      const data = await response.json();
      if (response.ok) {
        setUploadsDir(data.uploadsDir);
        // Automatically scan the new folder
        await handleScanFolder();
        alert("Upload directory updated and scanned successfully!");
      } else {
        alert(`Failed to update: ${data.error}`);
      }
    } catch (error) {
      console.error("Failed to update uploads directory:", error);
      alert("An error occurred while updating the directory.");
    } finally {
      setIsUpdatingUploadsDir(false);
    }
  };

  const handleResetUploadsDir = async () => {
    const defaultDir = "storage/uploads";
    setNewUploadsDir(defaultDir);
    setIsUpdatingUploadsDir(true);
    try {
      const response = await fetch("/api/config/uploads-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadsDir: defaultDir }),
      });
      const data = await response.json();
      if (response.ok) {
        setUploadsDir(data.uploadsDir);
        await handleScanFolder();
      }
    } catch (error) {
      console.error("Failed to reset uploads directory:", error);
    } finally {
      setIsUpdatingUploadsDir(false);
    }
  };

  const handleScanLocalFolder = async () => {
    if (!directoryHandle) {
      alert("Please select a local folder first using the 'Local Sync' button.");
      return;
    }

    const hasPermission = await requestDirPermission();
    if (!hasPermission) return;

    setIsScanning(true);
    let importedCount = 0;
    try {
      const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"];
      const videoExtensions = [".mp4", ".mov", ".webm", ".avi", ".mkv"];
      const existingFilenames = new Set(photos.map(p => p.originalName));

      for await (const entry of (directoryHandle as any).values()) {
        if (entry.kind === "file") {
          const file = await entry.getFile();
          if (existingFilenames.has(file.name)) continue;

          const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
          if (imageExtensions.includes(ext) || videoExtensions.includes(ext)) {
            const formData = new FormData();
            formData.append("photo", file);
            if (currentFolderId) formData.append("folderId", currentFolderId);

            const response = await fetch("/api/upload", {
              method: "POST",
              body: formData,
            });

            if (response.ok) {
              importedCount++;
            }
          }
        }
      }

      if (importedCount > 0) {
        await fetchPhotos();
        alert(`Local scan complete! Imported ${importedCount} new items.`);
      } else {
        alert("Local scan complete! No new items found.");
      }
    } catch (error) {
      console.error("Local scan failed:", error);
      alert("Failed to scan local folder.");
    } finally {
      setIsScanning(false);
    }
  };

  const fetchPhotos = async () => {
    try {
      const response = await fetch("/api/photos");
      const data = await response.json();
      setPhotos(data);
    } catch (error) {
      console.error("Failed to fetch photos:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleScanFolder = async () => {
    setIsScanning(true);
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: currentFolderId }),
      });
      const data = await response.json();
      if (response.ok) {
        if (data.count > 0) {
          await fetchPhotos();
          alert(`Scan complete! Found and imported ${data.count} new items from ${data.scannedDir}.`);
        } else {
          alert(`Scan complete! No new items found in ${data.scannedDir}.`);
        }
      } else {
        alert(`Scan failed: ${data.error}`);
      }
    } catch (error) {
      console.error("Failed to scan folder:", error);
      alert("An error occurred while scanning the folder.");
    } finally {
      setIsScanning(false);
    }
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    setUploadError(null);
    setShowProgressPanel(true);
    
    const newTasks: UploadTask[] = Array.from(files).map((file: File) => ({
      id: uuidv4(),
      fileName: file.name,
      progress: 0,
      status: 'uploading'
    }));
    
    setUploadTasks(prev => [...newTasks, ...prev]);

    const uploadPromises = newTasks.map((task, index) => {
      const file = files[index];
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append("photo", file);
        if (currentFolderId) {
          formData.append("folderId", currentFolderId);
        }

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percentComplete = Math.round((e.loaded / e.total) * 100);
            setUploadTasks(prev => prev.map(t => t.id === task.id ? { ...t, progress: percentComplete } : t));
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'completed', progress: 100 } : t));
            resolve(JSON.parse(xhr.responseText));
          } else {
            let errorMsg = `Upload failed with status ${xhr.status}`;
            try {
              const errorData = JSON.parse(xhr.responseText);
              errorMsg = errorData.error || errorMsg;
            } catch (e) {}
            setUploadTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'error', error: errorMsg } : t));
            reject(new Error(errorMsg));
          }
        };

        xhr.onerror = () => {
          const errorMsg = "Network error during upload";
          setUploadTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'error', error: errorMsg } : t));
          reject(new Error(errorMsg));
        };

        xhr.open("POST", "/api/upload");
        xhr.send(formData);
      });
    });

    try {
      await Promise.all(uploadPromises);
      await fetchPhotos();
    } catch (error: any) {
      console.error("Upload failed:", error);
      setUploadError("Some uploads failed. Check the progress panel for details.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async (id: string | null) => {
    if (!id) return;
    try {
      const response = await fetch(`/api/photos/${id}`, {
        method: "DELETE",
      });
      if (response.ok) {
        setPhotos(photos.filter((p) => p.id !== id));
        setPhotoToDelete(null);
      }
    } catch (error) {
      console.error("Delete failed:", error);
    }
  };

  const handleBatchDelete = async () => {
    if (selectedPhotoIds.length === 0) return;
    setIsDeletingBatch(true);
    try {
      const response = await fetch("/api/photos/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedPhotoIds }),
      });
      if (response.ok) {
        setPhotos(photos.filter((p) => !selectedPhotoIds.includes(p.id)));
        setSelectedPhotoIds([]);
        setIsBatchMode(false);
        setShowBatchDeleteConfirm(false);
      }
    } catch (error) {
      console.error("Batch delete failed:", error);
    } finally {
      setIsDeletingBatch(false);
    }
  };

  const handleMovePhotos = async (folderId: string | null) => {
    if (selectedPhotoIds.length === 0) return;
    setIsMovingPhotos(true);
    try {
      const response = await fetch("/api/photos/batch-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedPhotoIds, folderId }),
      });
      if (response.ok) {
        await fetchPhotos();
        setSelectedPhotoIds([]);
        setIsBatchMode(false);
        setShowMoveToFolderModal(false);
      }
    } catch (error) {
      console.error("Failed to move photos:", error);
    } finally {
      setIsMovingPhotos(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    setIsCreatingFolder(true);
    try {
      const response = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newFolderName.trim() }),
      });
      if (response.ok) {
        const newFolder = await response.json();
        setFolders(prev => [...prev, newFolder]);
        setNewFolderName("");
        setShowNewFolderModal(false);
      }
    } catch (error) {
      console.error("Failed to create folder:", error);
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleDeleteFolder = async (id: string) => {
    if (!confirm("Are you sure you want to delete this folder? Photos inside will be moved to the root gallery.")) return;
    try {
      const response = await fetch(`/api/folders/${id}`, {
        method: "DELETE",
      });
      if (response.ok) {
        setFolders(prev => prev.filter(f => f.id !== id));
        if (currentFolderId === id) setCurrentFolderId(null);
        await fetchPhotos();
      }
    } catch (error) {
      console.error("Failed to delete folder:", error);
    }
  };

  const handleRenameFolder = async (id: string, newName: string) => {
    try {
      const response = await fetch(`/api/folders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (response.ok) {
        setFolders(prev => prev.map(f => f.id === id ? { ...f, name: newName } : f));
      }
    } catch (error) {
      console.error("Failed to rename folder:", error);
    }
  };

  const handleBatchTags = async () => {
    if (selectedPhotoIds.length === 0 || !batchTagsInput.trim()) return;
    setIsApplyingBatchTags(true);
    const tags = batchTagsInput.split(",").map(t => t.trim()).filter(t => t !== "");
    try {
      const response = await fetch("/api/photos/batch-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedPhotoIds, tags }),
      });
      if (response.ok) {
        await fetchPhotos();
        setSelectedPhotoIds([]);
        setIsBatchMode(false);
        setShowBatchTagModal(false);
        setBatchTagsInput("");
      }
    } catch (error) {
      console.error("Batch tagging failed:", error);
    } finally {
      setIsApplyingBatchTags(false);
    }
  };

  const handleRename = async (id: string, newName: string) => {
    try {
      const response = await fetch(`/api/photos/${id}/rename`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName }),
      });
      if (response.ok) {
        setPhotos(photos.map((p) => (p.id === id ? { ...p, originalName: newName } : p)));
        if (selectedPhoto?.id === id) {
          setSelectedPhoto({ ...selectedPhoto, originalName: newName });
        }
      }
    } catch (error) {
      console.error("Failed to rename:", error);
    }
  };

  const handleUpdateTags = async (id: string, tags: string[]) => {
    try {
      const response = await fetch(`/api/photos/${id}/tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (response.ok) {
        setPhotos(photos.map((p) => (p.id === id ? { ...p, tags } : p)));
      }
    } catch (error) {
      console.error("Failed to update tags:", error);
    }
  };

  const allTags: string[] = Array.from(new Set(photos.flatMap((p) => p.tags)));

  const filteredPhotos = photos.filter((photo) => {
    const matchesSearch = photo.originalName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      photo.tags.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesTags = selectedTags.length === 0 || selectedTags.every(tag => photo.tags.includes(tag));
    const matchesFolder = (photo.folderId || null) === (currentFolderId || null);
    return matchesSearch && matchesTags && matchesFolder;
  }).sort((a, b) => {
    let comparison = 0;
    if (sortBy === "name") {
      comparison = a.originalName.localeCompare(b.originalName);
    } else if (sortBy === "date") {
      comparison = new Date(a.uploadDate).getTime() - new Date(b.uploadDate).getTime();
    } else if (sortBy === "tag") {
      const tagA = a.tags[0] || "";
      const tagB = b.tags[0] || "";
      comparison = tagA.localeCompare(tagB);
    }
    return sortOrder === "asc" ? comparison : -comparison;
  });

  const toggleTagFilter = (tag: string) => {
    setSelectedTags(prev => 
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  };

  const togglePhotoSelection = (id: string) => {
    setSelectedPhotoIds(prev => 
      prev.includes(id) ? prev.filter(pId => pId !== id) : [...prev, id]
    );
  };

  const handleBatchDownload = async () => {
    if (selectedPhotoIds.length === 0) return;
    
    setZipping(true);
    const zip = new JSZip();
    const selectedPhotos = photos.filter(p => selectedPhotoIds.includes(p.id));

    try {
      for (const photo of selectedPhotos) {
        const response = await fetch(`/uploads/${photo.filename}`);
        const blob = await response.blob();
        zip.file(photo.originalName, blob);
      }

      const content = await zip.generateAsync({ type: "blob" });
      const suggestedName = `photosync-batch-${new Date().getTime()}.zip`;

      let saved = false;
      if (directoryHandle) {
        saved = await saveFileToDirectory(suggestedName, content);
      }

      if (!saved) {
        // Try to use File System Access API picker
        if ("showSaveFilePicker" in window) {
          try {
            const handle = await (window as any).showSaveFilePicker({
              suggestedName,
              types: [{
                description: "ZIP Archive",
                accept: { "application/zip": [".zip"] },
              }],
            });
            const writable = await handle.createWritable();
            await writable.write(content);
            await writable.close();
            saved = true;
          } catch (err) {
            if ((err as Error).name !== "AbortError") throw err;
          }
        }
      }

      if (!saved) {
        // Fallback to traditional download
        const url = window.URL.createObjectURL(content);
        const link = document.createElement("a");
        link.href = url;
        link.download = suggestedName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      }
      
      // Reset selection after download
      setSelectedPhotoIds([]);
      setIsBatchMode(false);
    } catch (error) {
      console.error("Batch download failed:", error);
    } finally {
      setZipping(false);
    }
  };

  const handleIndividualDownload = async () => {
    if (selectedPhotoIds.length === 0) return;
    
    const selectedPhotos = photos.filter(p => selectedPhotoIds.includes(p.id));
    
    // If we have a directory handle, we can save all files without multiple prompts!
    if (directoryHandle) {
      let hasPermission = dirPermissionStatus === "granted";
      if (!hasPermission) {
        hasPermission = await requestDirPermission() || false;
      }

      if (hasPermission) {
        setZipping(true); // Reuse zipping state for loading indicator
        try {
          for (const photo of selectedPhotos) {
            const response = await fetch(`/uploads/${photo.filename}`);
            const blob = await response.blob();
            await saveFileToDirectory(photo.originalName, blob);
          }
          setSelectedPhotoIds([]);
          setIsBatchMode(false);
          return;
        } catch (error) {
          console.error("Batch individual download to directory failed:", error);
        } finally {
          setZipping(false);
        }
      }
    }

    // Fallback: For individual downloads without a directory handle, showSaveFilePicker is difficult 
    // because it requires a user gesture for EACH file. We'll stick to traditional downloads here.
    for (let i = 0; i < selectedPhotos.length; i++) {
      const photo = selectedPhotos[i];
      const link = document.createElement("a");
      link.href = `/uploads/${photo.filename}`;
      link.download = photo.originalName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      if (i < selectedPhotos.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    setSelectedPhotoIds([]);
    setIsBatchMode(false);
  };

  const selectAll = () => {
    if (selectedPhotoIds.length === filteredPhotos.length) {
      setSelectedPhotoIds([]);
    } else {
      setSelectedPhotoIds(filteredPhotos.map(p => p.id));
    }
  };

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-stone-200">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
              <ImageIcon className="text-emerald-600" size={24} />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">MediaSync</h1>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden lg:flex items-center gap-2 text-stone-400 text-xs bg-stone-100 px-3 py-1.5 rounded-lg" title={`Saving to: ${uploadsDir}`}>
              <Info size={14} />
              <span className="max-w-[150px] truncate">Storage: {uploadsDir}</span>
            </div>
            
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-2 rounded-xl transition-all ${
                showSettings 
                  ? "bg-stone-900 text-white" 
                  : "bg-white border border-stone-200 text-stone-600 hover:border-stone-900"
              }`}
              title="Settings"
            >
              <Settings size={20} />
            </button>

            <button
              onClick={() => {
                setIsBatchMode(!isBatchMode);
                if (isBatchMode) setSelectedPhotoIds([]);
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all ${
                isBatchMode 
                  ? "bg-stone-900 text-white" 
                  : "bg-white border border-stone-200 text-stone-600 hover:border-stone-900"
              }`}
            >
              {isBatchMode ? <X size={20} /> : <CheckSquare size={20} />}
              <span className="hidden sm:inline">{isBatchMode ? "Cancel" : "Select"}</span>
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl transition-colors disabled:opacity-50"
            >
              {uploading ? <Loader2 className="animate-spin" size={20} /> : <Upload size={20} />}
              <span className="hidden sm:inline">{uploading ? "Uploading..." : "Upload Media"}</span>
            </button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleUpload}
              className="hidden"
              accept="image/*,video/*,.mov,.mp4"
              multiple
            />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Error Message */}
        {uploadError && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl flex items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3 text-red-600">
              <Info size={20} />
              <p className="font-medium">{uploadError}</p>
            </div>
            <button 
              onClick={() => setUploadError(null)}
              className="p-1 hover:bg-red-100 rounded-lg transition-colors"
            >
              <X size={18} className="text-red-600" />
            </button>
          </motion.div>
        )}

        {/* Settings Panel */}
        <AnimatePresence>
          {showSettings && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden mb-8"
            >
              <div className="bg-white border border-stone-200 rounded-3xl p-6 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Settings size={20} className="text-stone-400" />
                    Application Settings
                  </h2>
                  <button onClick={() => setShowSettings(false)} className="text-stone-400 hover:text-stone-900">
                    <X size={20} />
                  </button>
                </div>

                <div className="space-y-6">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 bg-stone-50 rounded-2xl border border-stone-100">
                    <div>
                      <h3 className="font-medium text-stone-900 flex items-center gap-2">
                        <Folder size={18} className="text-emerald-600" />
                        Default Download Folder
                      </h3>
                      <p className="text-sm text-stone-500 mt-1">
                        {directoryHandle 
                          ? `Currently saving to: ${directoryHandle.name}` 
                          : "Choose a folder to save photos directly without prompts."}
                      </p>
                      {directoryHandle && dirPermissionStatus !== "granted" && (
                        <p className="text-xs text-amber-600 mt-1 font-medium">
                          Permission required to save files.
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {directoryHandle ? (
                        <>
                          {dirPermissionStatus !== "granted" && (
                            <button
                              onClick={requestDirPermission}
                              className="px-4 py-2 bg-amber-100 text-amber-700 hover:bg-amber-200 rounded-xl text-sm font-medium transition-colors"
                            >
                              Grant Permission
                            </button>
                          )}
                          <button
                            onClick={handleSelectDirectory}
                            className="px-4 py-2 bg-white border border-stone-200 text-stone-600 hover:border-stone-900 rounded-xl text-sm font-medium transition-colors"
                          >
                            Change Folder
                          </button>
                          <button
                            onClick={clearDirectory}
                            className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-xl text-sm font-medium transition-colors"
                          >
                            Clear
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={handleSelectDirectory}
                          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
                        >
                          <Folder size={18} />
                          Select Folder
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="p-4 bg-stone-50 rounded-2xl border border-stone-100">
                    <h3 className="font-medium text-stone-900 flex items-center gap-2 mb-2">
                      <Upload size={18} className="text-emerald-600" />
                      Server Upload Directory
                    </h3>
                    <p className="text-sm text-stone-500 mb-4">
                      The folder on your computer where the app stores uploaded photos.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newUploadsDir}
                        onChange={(e) => setNewUploadsDir(e.target.value)}
                        placeholder="e.g. C:\Photos or /Users/me/photos"
                        className="flex-1 px-4 py-2 bg-white border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      />
                      <button
                        onClick={handleUpdateUploadsDir}
                        disabled={isUpdatingUploadsDir || newUploadsDir === uploadsDir}
                        className="px-4 py-2 bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 rounded-xl text-sm font-medium transition-colors"
                      >
                        {isUpdatingUploadsDir ? "Updating..." : "Update"}
                      </button>
                      <button
                        onClick={handleResetUploadsDir}
                        disabled={isUpdatingUploadsDir}
                        className="px-4 py-2 bg-stone-200 text-stone-600 hover:bg-stone-300 disabled:opacity-50 rounded-xl text-sm font-medium transition-colors"
                        title="Reset to default storage/uploads"
                      >
                        Reset
                      </button>
                      <button
                        onClick={handleScanFolder}
                        disabled={isScanning}
                        className="px-4 py-2 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 rounded-xl text-sm font-medium transition-colors flex items-center gap-2"
                        title="Scan server folder for new media"
                      >
                        {isScanning ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
                        Scan Server
                      </button>
                      {directoryHandle && (
                        <button
                          onClick={handleScanLocalFolder}
                          disabled={isScanning}
                          className="px-4 py-2 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 rounded-xl text-sm font-medium transition-colors flex items-center gap-2"
                          title="Scan local folder for new media"
                        >
                          {isScanning ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
                          Scan Local
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-stone-400 dark:text-stone-500 mt-2 italic">
                      Note: Changing this won't move existing photos, but new uploads will go here.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Folder Navigation */}
        <div className="mb-6 flex items-center gap-3 overflow-x-auto pb-2 scrollbar-hide">
          <button
            onClick={() => setCurrentFolderId(null)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all shrink-0 ${
              currentFolderId === null
                ? "bg-emerald-600 text-white shadow-lg shadow-emerald-500/20"
                : "bg-white border border-stone-200 text-stone-600 hover:border-emerald-500"
            }`}
          >
            <ImageIcon size={16} />
            All Photos
          </button>
          
          {folders.map(folder => (
            <div key={folder.id} className="relative group shrink-0">
              <button
                onClick={() => setCurrentFolderId(folder.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  currentFolderId === folder.id
                    ? "bg-emerald-600 text-white shadow-lg shadow-emerald-500/20"
                    : "bg-white border border-stone-200 text-stone-600 hover:border-emerald-500"
                }`}
              >
                <Folder size={16} />
                {folder.name}
              </button>
              <div className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                <button 
                  onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder.id); }}
                  className="p-1 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-sm"
                >
                  <X size={10} />
                </button>
              </div>
            </div>
          ))}

          <button
            onClick={() => setShowNewFolderModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-dashed border-stone-300 text-stone-500 hover:border-emerald-500 hover:text-emerald-600 transition-all shrink-0"
          >
            <Plus size={16} />
            New Folder
          </button>
        </div>

        {/* Search and Filters */}
        <div className="mb-6 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
          <div className="flex-1 w-full space-y-3">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-stone-400" size={18} />
              <input
                type="text"
                placeholder="Search by name or tag..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-11 pr-4 py-2.5 bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-sm"
              />
            </div>

            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {allTags.map(tag => (
                  <button
                    key={tag}
                    onClick={() => toggleTagFilter(tag)}
                    className={`px-3 py-1 rounded-full text-sm font-medium transition-all ${
                      selectedTags.includes(tag)
                        ? "bg-emerald-600 text-white"
                        : "bg-white border border-stone-200 text-stone-600 hover:border-emerald-500"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 bg-white border border-stone-200 p-1.5 rounded-2xl shrink-0 self-end md:self-center">
            {gridSize === "list" && (
              <div className="flex items-center gap-1 pr-2 mr-2 border-r border-stone-200">
                <button
                  onClick={() => setSortBy("name")}
                  className={`p-2 rounded-xl transition-all ${sortBy === "name" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-600"}`}
                  title="Sort by Name"
                >
                  <ArrowUpAZ size={18} />
                </button>
                <button
                  onClick={() => setSortBy("date")}
                  className={`p-2 rounded-xl transition-all ${sortBy === "date" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-600"}`}
                  title="Sort by Date"
                >
                  <Calendar size={18} />
                </button>
                <button
                  onClick={() => setSortBy("tag")}
                  className={`p-2 rounded-xl transition-all ${sortBy === "tag" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-600"}`}
                  title="Sort by Tag"
                >
                  <Hash size={18} />
                </button>
                <button
                  onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
                  className="p-2 rounded-xl text-emerald-600 hover:bg-emerald-50 transition-all"
                  title={sortOrder === "asc" ? "Ascending" : "Descending"}
                >
                  {sortOrder === "asc" ? <SortAsc size={18} /> : <SortDesc size={18} />}
                </button>
              </div>
            )}
            <button
              onClick={() => setGridSize("lg")}
              className={`p-1.5 rounded-lg transition-all ${gridSize === "lg" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-600"}`}
              title="Large Grid"
            >
              <Grid2X2 size={18} />
            </button>
            <button
              onClick={() => setGridSize("md")}
              className={`p-1.5 rounded-lg transition-all ${gridSize === "md" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-600"}`}
              title="Medium Grid"
            >
              <Grid3X3 size={18} />
            </button>
            <button
              onClick={() => setGridSize("sm")}
              className={`p-1.5 rounded-lg transition-all ${gridSize === "sm" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-600"}`}
              title="Small Grid"
            >
              <LayoutGrid size={18} />
            </button>
            <button
              onClick={() => setGridSize("list")}
              className={`p-1.5 rounded-lg transition-all ${gridSize === "list" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-600"}`}
              title="List View"
            >
              <List size={18} />
            </button>
          </div>
        </div>

        {/* Photo Grid */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-stone-400">
            <Loader2 className="animate-spin mb-4" size={40} />
            <p>Loading your gallery...</p>
          </div>
        ) : filteredPhotos.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-3xl border border-dashed border-stone-200">
            <div className="w-16 h-16 bg-stone-100 rounded-full flex items-center justify-center mx-auto mb-4 text-stone-400">
              <ImageIcon size={32} />
            </div>
            <h3 className="text-lg font-medium text-stone-900">No photos found</h3>
            <p className="text-stone-500">Try uploading some photos or adjusting your search.</p>
          </div>
        ) : (
          <div className={`grid gap-6 ${
            gridSize === "sm" 
              ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8" 
              : gridSize === "md"
              ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              : gridSize === "lg"
              ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3"
              : "grid-cols-1"
          }`}>
            <AnimatePresence mode="popLayout">
              {filteredPhotos.map((photo) => (
                <PhotoCard
                  key={photo.id}
                  photo={photo}
                  viewMode={gridSize}
                  onDelete={() => setPhotoToDelete(photo.id)}
                  onUpdateTags={(tags) => handleUpdateTags(photo.id, tags)}
                  onRename={(newName) => handleRename(photo.id, newName)}
                  onView={() => setSelectedPhoto(photo)}
                  onMove={() => { setSelectedPhotoIds([photo.id]); setShowMoveToFolderModal(true); }}
                  isSelected={selectedPhotoIds.includes(photo.id)}
                  onSelect={() => togglePhotoSelection(photo.id)}
                  isBatchMode={isBatchMode}
                  directoryHandle={directoryHandle}
                  dirPermissionStatus={dirPermissionStatus}
                  requestDirPermission={requestDirPermission}
                  saveFileToDirectory={saveFileToDirectory}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </main>

      {/* Batch Action Bar */}
      <AnimatePresence>
        {isBatchMode && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40"
          >
            <div className="bg-stone-900 text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-6 border border-white/10 backdrop-blur-xl">
              <div className="flex items-center gap-3 pr-6 border-r border-white/10">
                <button
                  onClick={selectAll}
                  className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                  title="Select All"
                >
                  {selectedPhotoIds.length === filteredPhotos.length ? <CheckSquare size={20} /> : <Square size={20} />}
                </button>
                <span className="text-sm font-medium whitespace-nowrap">
                  {selectedPhotoIds.length} selected
                </span>
              </div>
              
              <div className="flex items-center gap-3">
                <button
                  onClick={handleBatchDownload}
                  disabled={selectedPhotoIds.length === 0 || zipping}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:hover:bg-emerald-600 px-4 py-2 rounded-xl font-medium transition-all"
                  title="Download as ZIP"
                >
                  {zipping ? <Loader2 className="animate-spin" size={18} /> : <Download size={18} />}
                  ZIP
                </button>
                <button
                  onClick={handleIndividualDownload}
                  disabled={selectedPhotoIds.length === 0 || zipping}
                  className="flex items-center gap-2 bg-stone-700 hover:bg-stone-600 disabled:opacity-50 px-4 py-2 rounded-xl font-medium transition-all"
                  title="Download files individually"
                >
                  <Files size={18} />
                  Individual
                </button>
                <button
                  onClick={() => setShowMoveToFolderModal(true)}
                  disabled={selectedPhotoIds.length === 0 || zipping}
                  className="flex items-center gap-2 bg-stone-700 hover:bg-stone-600 disabled:opacity-50 px-4 py-2 rounded-xl font-medium transition-all"
                  title="Move selected items to a folder"
                >
                  <FolderCheck size={18} />
                  Move
                </button>
                <button
                  onClick={() => setShowBatchTagModal(true)}
                  disabled={selectedPhotoIds.length === 0 || zipping}
                  className="flex items-center gap-2 bg-stone-700 hover:bg-stone-600 disabled:opacity-50 px-4 py-2 rounded-xl font-medium transition-all"
                  title="Tag selected items"
                >
                  <Tag size={18} />
                  Tag
                </button>
                <button
                  onClick={() => setShowBatchDeleteConfirm(true)}
                  disabled={selectedPhotoIds.length === 0 || zipping}
                  className="flex items-center gap-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 disabled:opacity-50 px-4 py-2 rounded-xl font-medium transition-all"
                  title="Delete selected items"
                >
                  <Trash2 size={18} />
                  Delete
                </button>
                <button
                  onClick={() => {
                    setIsBatchMode(false);
                    setSelectedPhotoIds([]);
                  }}
                  className="px-4 py-2 hover:bg-white/10 rounded-xl font-medium transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Photo Modal */}
      <AnimatePresence>
        {selectedPhoto && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
            onClick={() => setSelectedPhoto(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative max-w-5xl w-full max-h-[90vh] flex flex-col items-center"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setSelectedPhoto(null)}
                className="absolute -top-12 right-0 p-2 text-white/70 hover:text-white transition-colors"
              >
                <X size={32} />
              </button>

              <div className="relative w-full h-full flex items-center justify-center overflow-hidden rounded-2xl bg-stone-900">
                {selectedPhoto.filename.toLowerCase().endsWith(".mov") || 
                 selectedPhoto.filename.toLowerCase().endsWith(".mp4") ||
                 selectedPhoto.filename.toLowerCase().endsWith(".webm") ? (
                  <video
                    src={`/uploads/${selectedPhoto.filename}`}
                    className="max-w-full max-h-full"
                    controls
                    autoPlay
                  />
                ) : (
                  <img
                    src={`/uploads/${selectedPhoto.filename}`}
                    alt={selectedPhoto.originalName}
                    className="max-w-full max-h-full object-contain"
                    referrerPolicy="no-referrer"
                  />
                )}
              </div>

              <div className="mt-4 w-full flex items-center justify-between text-white">
                <div className="max-w-[70%]">
                  <h3 
                    onClick={() => {
                      const newName = prompt("Rename media to:", selectedPhoto.originalName);
                      if (newName && newName !== selectedPhoto.originalName) {
                        handleRename(selectedPhoto.id, newName);
                      }
                    }}
                    className="text-lg font-medium truncate cursor-pointer hover:text-emerald-400 transition-colors"
                    title="Click to rename"
                  >
                    {selectedPhoto.originalName}
                  </h3>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {selectedPhoto.tags.map(tag => (
                      <span key={tag} className="px-2 py-0.5 bg-white/10 rounded text-xs">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <a
                  href={`/uploads/${selectedPhoto.filename}`}
                  download={selectedPhoto.originalName}
                  className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-medium transition-colors shrink-0"
                >
                  <Download size={20} />
                  Download
                </a>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {photoToDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setPhotoToDelete(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white dark:bg-stone-900 rounded-3xl p-6 max-w-sm w-full shadow-2xl border border-stone-200 dark:border-stone-800"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-12 h-12 bg-red-100 dark:bg-red-900/30 rounded-2xl flex items-center justify-center mb-4">
                <Trash2 className="text-red-600 dark:text-red-400" size={24} />
              </div>
              <h3 className="text-xl font-bold text-stone-900 dark:text-stone-100 mb-2">Delete Media?</h3>
              <p className="text-stone-500 dark:text-stone-400 mb-6">
                Are you sure you want to delete this file? This action cannot be undone.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setPhotoToDelete(null)}
                  className="flex-1 px-4 py-2 bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700 rounded-xl font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(photoToDelete)}
                  className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl font-medium transition-colors"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Batch Delete Confirmation Modal */}
      <AnimatePresence>
        {showBatchDeleteConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setShowBatchDeleteConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl border border-stone-200"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-12 h-12 bg-red-100 rounded-2xl flex items-center justify-center mb-4">
                <Trash2 className="text-red-600" size={24} />
              </div>
              <h3 className="text-xl font-bold text-stone-900 mb-2">Delete {selectedPhotoIds.length} Items?</h3>
              <p className="text-stone-500 mb-6">
                Are you sure you want to delete these {selectedPhotoIds.length} files? This action cannot be undone.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowBatchDeleteConfirm(false)}
                  disabled={isDeletingBatch}
                  className="flex-1 px-4 py-2 bg-stone-100 text-stone-600 hover:bg-stone-200 rounded-xl font-medium transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleBatchDelete}
                  disabled={isDeletingBatch}
                  className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isDeletingBatch ? <Loader2 className="animate-spin" size={18} /> : "Delete All"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Batch Tag Modal */}
      <AnimatePresence>
        {showBatchTagModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setShowBatchTagModal(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white dark:bg-stone-900 rounded-3xl p-6 max-w-sm w-full shadow-2xl border border-stone-200 dark:border-stone-800"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-12 h-12 bg-emerald-100 dark:bg-emerald-900/30 rounded-2xl flex items-center justify-center mb-4">
                <Tag className="text-emerald-600 dark:text-emerald-400" size={24} />
              </div>
              <h3 className="text-xl font-bold text-stone-900 dark:text-stone-100 mb-2">Tag {selectedPhotoIds.length} Items</h3>
              <p className="text-stone-500 dark:text-stone-400 mb-4 text-sm">
                Enter tags separated by commas to apply to all selected items.
              </p>
              <input
                autoFocus
                type="text"
                value={batchTagsInput}
                onChange={(e) => setBatchTagsInput(e.target.value)}
                placeholder="e.g. vacation, family, 2024"
                className="w-full px-4 py-2.5 bg-stone-50 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 dark:text-stone-100 mb-6"
                onKeyDown={(e) => e.key === "Enter" && handleBatchTags()}
              />
              <div className="flex gap-3">
                <button
                  onClick={() => setShowBatchTagModal(false)}
                  disabled={isApplyingBatchTags}
                  className="flex-1 px-4 py-2 bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700 rounded-xl font-medium transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleBatchTags}
                  disabled={isApplyingBatchTags || !batchTagsInput.trim()}
                  className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isApplyingBatchTags ? <Loader2 className="animate-spin" size={18} /> : "Apply Tags"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

        {/* New Folder Modal */}
        <AnimatePresence>
          {showNewFolderModal && (
            <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl border border-stone-100"
              >
                <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mb-6 text-emerald-600 mx-auto">
                  <Folder size={32} />
                </div>
                <h3 className="text-2xl font-bold text-stone-900 text-center mb-2">New Folder</h3>
                <p className="text-stone-500 text-center mb-6">Enter a name for your new folder.</p>
                
                <input
                  type="text"
                  autoFocus
                  placeholder="Folder name..."
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
                  className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl mb-6 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                />

                <div className="flex gap-3">
                  <button
                    onClick={() => setShowNewFolderModal(false)}
                    className="flex-1 px-6 py-3 bg-stone-100 text-stone-600 font-semibold rounded-2xl hover:bg-stone-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateFolder}
                    disabled={isCreatingFolder || !newFolderName.trim()}
                    className="flex-1 px-6 py-3 bg-emerald-600 text-white font-semibold rounded-2xl hover:bg-emerald-700 transition-colors flex items-center justify-center gap-2"
                  >
                    {isCreatingFolder ? <Loader2 className="animate-spin" size={20} /> : "Create"}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Move to Folder Modal */}
        <AnimatePresence>
          {showMoveToFolderModal && (
            <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl border border-stone-100"
              >
                <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-6 text-blue-600 mx-auto">
                  <FolderCheck size={32} />
                </div>
                <h3 className="text-2xl font-bold text-stone-900 text-center mb-2">Move {selectedPhotoIds.length} items</h3>
                <p className="text-stone-500 text-center mb-6">Select a destination folder.</p>
                
                <div className="max-h-60 overflow-y-auto space-y-2 mb-6 pr-2 custom-scrollbar">
                  <button
                    onClick={() => handleMovePhotos(null)}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl hover:bg-stone-100 transition-colors text-left group"
                  >
                    <div className="w-10 h-10 bg-stone-100 rounded-xl flex items-center justify-center text-stone-400 group-hover:bg-white">
                      <ImageIcon size={20} />
                    </div>
                    <div>
                      <p className="font-medium text-stone-900">Root Gallery</p>
                      <p className="text-xs text-stone-500">Main collection</p>
                    </div>
                  </button>

                  {folders.map(folder => (
                    <button
                      key={folder.id}
                      onClick={() => handleMovePhotos(folder.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl hover:bg-stone-100 transition-colors text-left group"
                    >
                      <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600 group-hover:bg-white">
                        <Folder size={20} />
                      </div>
                      <div>
                        <p className="font-medium text-stone-900">{folder.name}</p>
                        <p className="text-xs text-stone-500">Folder</p>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setShowMoveToFolderModal(false)}
                    className="flex-1 px-6 py-3 bg-stone-100 text-stone-600 font-semibold rounded-2xl hover:bg-stone-200 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      <AnimatePresence>
        {showProgressPanel && uploadTasks.length > 0 && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-8 right-8 z-50 w-80 max-h-[400px] flex flex-col bg-white rounded-3xl shadow-2xl border border-stone-200 overflow-hidden"
          >
            <div className="p-4 border-b border-stone-100 flex items-center justify-between bg-stone-50">
              <h3 className="font-semibold text-stone-900 flex items-center gap-2">
                <Upload size={18} className="text-emerald-600" />
                Uploads
              </h3>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setUploadTasks([])}
                  className="text-xs text-stone-400 hover:text-stone-600 font-medium"
                >
                  Clear
                </button>
                <button 
                  onClick={() => setShowProgressPanel(false)}
                  className="p-1 hover:bg-stone-200 rounded-lg transition-colors"
                >
                  <X size={18} className="text-stone-400" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {uploadTasks.map(task => (
                <div key={task.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-stone-700 truncate">
                      {task.fileName}
                    </p>
                    <div className="shrink-0">
                      {task.status === 'uploading' && (
                        <span className="text-[10px] font-bold text-emerald-600">{task.progress}%</span>
                      )}
                      {task.status === 'completed' && (
                        <CheckCircle2 size={16} className="text-emerald-600" />
                      )}
                      {task.status === 'error' && (
                        <AlertCircle size={16} className="text-red-500" />
                      )}
                    </div>
                  </div>
                  <div className="h-1.5 w-full bg-stone-100 rounded-full overflow-hidden">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${task.progress}%` }}
                      className={`h-full transition-all duration-300 ${
                        task.status === 'error' ? 'bg-red-500' : 'bg-emerald-600'
                      }`}
                    />
                  </div>
                  {task.error && (
                    <p className="text-[10px] text-red-500 font-medium truncate">
                      {task.error}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!showProgressPanel && uploadTasks.some(t => t.status === 'uploading') && (
        <button 
          onClick={() => setShowProgressPanel(true)}
          className="fixed bottom-8 right-8 z-50 bg-emerald-600 text-white p-4 rounded-full shadow-xl hover:bg-emerald-700 transition-all animate-bounce"
        >
          <Upload size={24} />
        </button>
      )}
    </div>
  );
}

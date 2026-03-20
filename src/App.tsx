import React, { useState, useEffect, useRef } from "react";
import { Upload, Tag, Trash2, Plus, X, Search, Image as ImageIcon, Loader2, Info, Download, Maximize2, CheckSquare, Square, Check, LayoutGrid, Grid3X3, Grid2X2, Files, Settings, Folder, FolderCheck, Moon, Sun, List, ArrowUpDown, ArrowUpAZ, ArrowDownAZ, Calendar, Hash, SortAsc, SortDesc, CheckCircle2, AlertCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import JSZip from "jszip";
import { v4 as uuidv4 } from "uuid";

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

interface Photo {
  id: string;
  filename: string;
  originalName: string;
  tags: string[];
  uploadDate: string;
  type?: "image" | "video";
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
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("darkMode");
      return saved ? JSON.parse(saved) : window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return false;
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    localStorage.setItem("darkMode", JSON.stringify(isDarkMode));
  }, [isDarkMode]);

  useEffect(() => {
    fetchPhotos();
    fetchConfig();
    initDirectoryHandle();
  }, []);

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
        alert("Upload directory updated successfully!");
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

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this photo?")) return;

    try {
      const response = await fetch(`/api/photos/${id}`, {
        method: "DELETE",
      });
      if (response.ok) {
        setPhotos(photos.filter((p) => p.id !== id));
      }
    } catch (error) {
      console.error("Delete failed:", error);
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
    return matchesSearch && matchesTags;
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
    <div className="min-h-screen bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 font-sans transition-colors duration-300">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/80 dark:bg-stone-900/80 backdrop-blur-md border-b border-stone-200 dark:border-stone-800">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-stone-100 dark:bg-stone-800 rounded-xl flex items-center justify-center overflow-hidden">
              <img 
                src="https://upload.wikimedia.org/wikipedia/en/a/a2/Obelix_Asterix.png" 
                alt="Obelix" 
                className="w-full h-full object-contain p-0.5"
                referrerPolicy="no-referrer"
              />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">MediaSync</h1>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden lg:flex items-center gap-2 text-stone-400 dark:text-stone-500 text-xs bg-stone-100 dark:bg-stone-800 px-3 py-1.5 rounded-lg" title={`Saving to: ${uploadsDir}`}>
              <Info size={14} />
              <span className="max-w-[150px] truncate">Storage: {uploadsDir}</span>
            </div>

            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="p-2 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:border-stone-900 dark:hover:border-stone-100 rounded-xl transition-all"
              title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-2 rounded-xl transition-all ${
                showSettings 
                  ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900" 
                  : "bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:border-stone-900 dark:hover:border-stone-100"
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
                  ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900" 
                  : "bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:border-stone-900 dark:hover:border-stone-100"
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
            className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl flex items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3 text-red-600 dark:text-red-400">
              <Info size={20} />
              <p className="font-medium">{uploadError}</p>
            </div>
            <button 
              onClick={() => setUploadError(null)}
              className="p-1 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-lg transition-colors"
            >
              <X size={18} className="text-red-600 dark:text-red-400" />
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
              <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-3xl p-6 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold flex items-center gap-2 dark:text-stone-100">
                    <Settings size={20} className="text-stone-400" />
                    Application Settings
                  </h2>
                  <button onClick={() => setShowSettings(false)} className="text-stone-400 hover:text-stone-900 dark:hover:text-stone-100">
                    <X size={20} />
                  </button>
                </div>

                <div className="space-y-6">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 bg-stone-50 dark:bg-stone-800/50 rounded-2xl border border-stone-100 dark:border-stone-800">
                    <div>
                      <h3 className="font-medium text-stone-900 dark:text-stone-100 flex items-center gap-2">
                        <Moon size={18} className="text-emerald-600" />
                        Appearance
                      </h3>
                      <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
                        Choose between light and dark mode.
                      </p>
                    </div>
                    <button
                      onClick={() => setIsDarkMode(!isDarkMode)}
                      className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:border-stone-900 dark:hover:border-stone-100 rounded-xl text-sm font-medium transition-all"
                    >
                      {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
                      {isDarkMode ? "Switch to Light" : "Switch to Dark"}
                    </button>
                  </div>

                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 bg-stone-50 dark:bg-stone-800/50 rounded-2xl border border-stone-100 dark:border-stone-800">
                    <div>
                      <h3 className="font-medium text-stone-900 dark:text-stone-100 flex items-center gap-2">
                        <Folder size={18} className="text-emerald-600" />
                        Default Download Folder
                      </h3>
                      <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
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
                              className="px-4 py-2 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 rounded-xl text-sm font-medium transition-colors"
                            >
                              Grant Permission
                            </button>
                          )}
                          <button
                            onClick={handleSelectDirectory}
                            className="px-4 py-2 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:border-stone-900 dark:hover:border-stone-100 rounded-xl text-sm font-medium transition-colors"
                          >
                            Change Folder
                          </button>
                          <button
                            onClick={clearDirectory}
                            className="px-4 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl text-sm font-medium transition-colors"
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

                  <div className="p-4 bg-stone-50 dark:bg-stone-800/50 rounded-2xl border border-stone-100 dark:border-stone-800">
                    <h3 className="font-medium text-stone-900 dark:text-stone-100 flex items-center gap-2 mb-2">
                      <Upload size={18} className="text-emerald-600" />
                      Server Upload Directory
                    </h3>
                    <p className="text-sm text-stone-500 dark:text-stone-400 mb-4">
                      The folder on your computer where the app stores uploaded photos.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newUploadsDir}
                        onChange={(e) => setNewUploadsDir(e.target.value)}
                        placeholder="e.g. C:\Photos or /Users/me/photos"
                        className="flex-1 px-4 py-2 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 dark:text-stone-100"
                      />
                      <button
                        onClick={handleUpdateUploadsDir}
                        disabled={isUpdatingUploadsDir || newUploadsDir === uploadsDir}
                        className="px-4 py-2 bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50 rounded-xl text-sm font-medium transition-colors"
                      >
                        {isUpdatingUploadsDir ? "Updating..." : "Update"}
                      </button>
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

        {/* Search and Filters */}
        <div className="mb-8 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
          <div className="flex-1 w-full space-y-4">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-stone-400 dark:text-stone-500" size={20} />
              <input
                type="text"
                placeholder="Search by name or tag..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 dark:text-stone-100 transition-all"
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
                        : "bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:border-emerald-500"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 p-1.5 rounded-2xl shrink-0 self-end md:self-center">
            {gridSize === "list" && (
              <div className="flex items-center gap-1 pr-2 mr-2 border-r border-stone-200 dark:border-stone-800">
                <button
                  onClick={() => setSortBy("name")}
                  className={`p-2 rounded-xl transition-all ${sortBy === "name" ? "bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100" : "text-stone-400 hover:text-stone-600"}`}
                  title="Sort by Name"
                >
                  <ArrowUpAZ size={18} />
                </button>
                <button
                  onClick={() => setSortBy("date")}
                  className={`p-2 rounded-xl transition-all ${sortBy === "date" ? "bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100" : "text-stone-400 hover:text-stone-600"}`}
                  title="Sort by Date"
                >
                  <Calendar size={18} />
                </button>
                <button
                  onClick={() => setSortBy("tag")}
                  className={`p-2 rounded-xl transition-all ${sortBy === "tag" ? "bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100" : "text-stone-400 hover:text-stone-600"}`}
                  title="Sort by Tag"
                >
                  <Hash size={18} />
                </button>
                <button
                  onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
                  className="p-2 rounded-xl text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-all"
                  title={sortOrder === "asc" ? "Ascending" : "Descending"}
                >
                  {sortOrder === "asc" ? <SortAsc size={18} /> : <SortDesc size={18} />}
                </button>
              </div>
            )}
            <button
              onClick={() => setGridSize("lg")}
              className={`p-2 rounded-xl transition-all ${gridSize === "lg" ? "bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100" : "text-stone-400 hover:text-stone-600"}`}
              title="Large Grid"
            >
              <Grid2X2 size={20} />
            </button>
            <button
              onClick={() => setGridSize("md")}
              className={`p-2 rounded-xl transition-all ${gridSize === "md" ? "bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100" : "text-stone-400 hover:text-stone-600"}`}
              title="Medium Grid"
            >
              <Grid3X3 size={20} />
            </button>
            <button
              onClick={() => setGridSize("sm")}
              className={`p-2 rounded-xl transition-all ${gridSize === "sm" ? "bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100" : "text-stone-400 hover:text-stone-600"}`}
              title="Small Grid"
            >
              <LayoutGrid size={20} />
            </button>
            <button
              onClick={() => setGridSize("list")}
              className={`p-2 rounded-xl transition-all ${gridSize === "list" ? "bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100" : "text-stone-400 hover:text-stone-600"}`}
              title="List View"
            >
              <List size={20} />
            </button>
          </div>
        </div>

        {/* Photo Grid */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-stone-400 dark:text-stone-600">
            <Loader2 className="animate-spin mb-4" size={40} />
            <p>Loading your gallery...</p>
          </div>
        ) : filteredPhotos.length === 0 ? (
          <div className="text-center py-20 bg-white dark:bg-stone-900 rounded-3xl border border-dashed border-stone-200 dark:border-stone-800">
            <div className="w-16 h-16 bg-stone-100 dark:bg-stone-800 rounded-full flex items-center justify-center mx-auto mb-4 text-stone-400 dark:text-stone-600">
              <ImageIcon size={32} />
            </div>
            <h3 className="text-lg font-medium text-stone-900 dark:text-stone-100">No photos found</h3>
            <p className="text-stone-500 dark:text-stone-400">Try uploading some photos or adjusting your search.</p>
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
                  onDelete={() => handleDelete(photo.id)}
                  onUpdateTags={(tags) => handleUpdateTags(photo.id, tags)}
                  onRename={(newName) => handleRename(photo.id, newName)}
                  onView={() => setSelectedPhoto(photo)}
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

      {/* Upload Progress Panel */}
      <AnimatePresence>
        {showProgressPanel && uploadTasks.length > 0 && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-8 right-8 z-50 w-80 max-h-[400px] flex flex-col bg-white dark:bg-stone-900 rounded-3xl shadow-2xl border border-stone-200 dark:border-stone-800 overflow-hidden"
          >
            <div className="p-4 border-b border-stone-100 dark:border-stone-800 flex items-center justify-between bg-stone-50 dark:bg-stone-800/50">
              <h3 className="font-semibold text-stone-900 dark:text-stone-100 flex items-center gap-2">
                <Upload size={18} className="text-emerald-600" />
                Uploads
              </h3>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setUploadTasks([])}
                  className="text-xs text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 font-medium"
                >
                  Clear
                </button>
                <button 
                  onClick={() => setShowProgressPanel(false)}
                  className="p-1 hover:bg-stone-200 dark:hover:bg-stone-700 rounded-lg transition-colors"
                >
                  <X size={18} className="text-stone-400" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {uploadTasks.map(task => (
                <div key={task.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-stone-700 dark:text-stone-300 truncate flex-1">
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
                  <div className="h-1.5 w-full bg-stone-100 dark:bg-stone-800 rounded-full overflow-hidden">
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

interface PhotoCardProps {
  key?: string | number;
  photo: Photo;
  viewMode: "sm" | "md" | "lg" | "list";
  onDelete: () => void | Promise<void>;
  onUpdateTags: (tags: string[]) => void | Promise<void>;
  onRename: (newName: string) => void | Promise<void>;
  onView: () => void;
  isSelected: boolean;
  onSelect: () => void;
  isBatchMode: boolean;
  directoryHandle: FileSystemDirectoryHandle | null;
  dirPermissionStatus: PermissionState | "prompt";
  requestDirPermission: () => Promise<boolean | undefined>;
  saveFileToDirectory: (filename: string, blob: Blob) => Promise<boolean>;
}

function PhotoCard({ photo, viewMode, onDelete, onUpdateTags, onRename, onView, isSelected, onSelect, isBatchMode, directoryHandle, dirPermissionStatus, requestDirPermission, saveFileToDirectory }: PhotoCardProps) {
  const [isEditingTags, setIsEditingTags] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(photo.originalName);
  const [newTag, setNewTag] = useState("");
  const [downloading, setDownloading] = useState(false);

  const isVideo = (filename: string) => {
    const ext = filename.split(".").pop()?.toLowerCase();
    return ["mp4", "mov", "webm"].includes(ext || "");
  };

  const addTag = () => {
    if (newTag.trim() && !photo.tags.includes(newTag.trim())) {
      onUpdateTags([...photo.tags, newTag.trim()]);
      setNewTag("");
    }
  };

  const removeTag = (tagToRemove: string) => {
    onUpdateTags(photo.tags.filter(t => t !== tagToRemove));
  };

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newName.trim() && newName.trim() !== photo.originalName) {
      onRename(newName.trim());
    }
    setIsRenaming(false);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      onClick={() => isBatchMode && onSelect()}
      className={`group bg-white dark:bg-stone-900 rounded-3xl overflow-hidden border transition-all cursor-pointer ${
        isSelected 
          ? "border-emerald-500 ring-2 ring-emerald-500/20 shadow-lg" 
          : "border-stone-200 dark:border-stone-800 shadow-sm hover:shadow-md"
      } ${viewMode === "list" ? "flex flex-row h-32" : "flex flex-col"}`}
    >
      <div className={`${viewMode === "list" ? "w-48 h-full" : "aspect-square"} relative overflow-hidden bg-stone-100 dark:bg-stone-800 shrink-0`}>
        {isVideo(photo.filename) ? (
          <video
            src={`/uploads/${photo.filename}`}
            className="w-full h-full object-cover"
            preload="metadata"
          />
        ) : (
          <img
            src={`/uploads/${photo.filename}`}
            alt={photo.originalName}
            className={`w-full h-full object-cover transition-transform duration-500 ${!isBatchMode && "group-hover:scale-110"}`}
            referrerPolicy="no-referrer"
          />
        )}
        
        {/* Selection Overlay */}
        {isBatchMode && (
          <div className={`absolute inset-0 flex items-center justify-center transition-colors ${isSelected ? "bg-emerald-500/10" : "bg-black/5"}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all ${
              isSelected 
                ? "bg-emerald-500 border-emerald-500 text-white" 
                : "bg-white/50 border-white text-transparent"
            }`}>
              <Check size={20} strokeWidth={3} />
            </div>
          </div>
        )}

        {!isBatchMode && (
          <div className={`absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center ${(viewMode === "list" || viewMode === "sm") ? "gap-2" : "gap-3"}`}>
            <button
              onClick={(e) => { e.stopPropagation(); onView(); }}
              className={`${(viewMode === "list" || viewMode === "sm") ? "p-2" : "p-3"} bg-white/20 backdrop-blur-md rounded-full text-white hover:bg-white/40 transition-colors`}
              title="View Full Size"
            >
              <Maximize2 size={(viewMode === "list" || viewMode === "sm") ? 16 : 20} />
            </button>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                setDownloading(true);
                try {
                  const response = await fetch(`/uploads/${photo.filename}`);
                  const blob = await response.blob();
                  
                  let saved = false;
                  if (directoryHandle) {
                    saved = await saveFileToDirectory(photo.originalName, blob);
                  }

                  if (!saved) {
                    if ("showSaveFilePicker" in window) {
                      try {
                        const handle = await (window as any).showSaveFilePicker({
                          suggestedName: photo.originalName,
                          types: [{
                            description: "Image File",
                            accept: { [blob.type]: [`.${photo.filename.split(".").pop()}`] },
                          }],
                        });
                        const writable = await handle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                        saved = true;
                      } catch (err) {
                        if ((err as Error).name !== "AbortError") console.error(err);
                      }
                    }
                  }

                  if (!saved) {
                    const url = window.URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = photo.originalName;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    window.URL.revokeObjectURL(url);
                  }
                } finally {
                  setDownloading(false);
                }
              }}
              className={`${(viewMode === "list" || viewMode === "sm") ? "p-2" : "p-3"} bg-white/20 backdrop-blur-md rounded-full text-white hover:bg-white/40 transition-colors`}
              title={directoryHandle ? `Save to ${directoryHandle.name}` : "Download (Choose location)"}
            >
              {downloading ? <Loader2 className="animate-spin" size={(viewMode === "list" || viewMode === "sm") ? 16 : 20} /> : <Download size={(viewMode === "list" || viewMode === "sm") ? 16 : 20} />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setIsEditingTags(!isEditingTags); }}
              className={`${(viewMode === "list" || viewMode === "sm") ? "p-2" : "p-3"} bg-white/20 backdrop-blur-md rounded-full text-white hover:bg-white/40 transition-colors`}
              title="Edit Tags"
            >
              <Tag size={(viewMode === "list" || viewMode === "sm") ? 16 : 20} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className={`${(viewMode === "list" || viewMode === "sm") ? "p-2" : "p-3"} bg-red-500/20 backdrop-blur-md rounded-full text-white hover:bg-red-500/40 transition-colors`}
              title="Delete Photo"
            >
              <Trash2 size={(viewMode === "list" || viewMode === "sm") ? 16 : 20} />
            </button>
          </div>
        )}
      </div>

      <div className={`p-4 flex-1 flex flex-col justify-between ${viewMode === "list" ? "min-w-0" : ""}`}>
        <div className="flex justify-between items-start gap-4">
          <div className="min-w-0 flex-1">
            {isRenaming ? (
              <form onSubmit={handleRenameSubmit} className="mb-1">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onBlur={() => setIsRenaming(false)}
                  className="w-full px-2 py-0.5 text-sm bg-white dark:bg-stone-800 border border-emerald-500 rounded outline-none dark:text-stone-100"
                />
              </form>
            ) : (
              <h4 
                onClick={(e) => { e.stopPropagation(); setIsRenaming(true); }}
                className="font-medium text-stone-900 dark:text-stone-100 truncate mb-1 cursor-pointer hover:text-emerald-600 transition-colors" 
                title="Click to rename"
              >
                {photo.originalName}
              </h4>
            )}
            
            <div className="flex flex-wrap gap-1.5">
              {photo.tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 rounded-md text-[10px] font-medium"
                >
                  {tag}
                  {isEditingTags && (
                    <button onClick={() => removeTag(tag)} className="hover:text-red-500">
                      <X size={10} />
                    </button>
                  )}
                </span>
              ))}
              {isEditingTags && (
                <div className="flex items-center gap-1 mt-1 w-full">
                  <input
                    type="text"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addTag()}
                    placeholder="Tag..."
                    className="flex-1 text-[10px] bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-md px-2 py-0.5 focus:outline-none focus:border-emerald-500 dark:text-stone-100"
                  />
                  <button
                    onClick={addTag}
                    className="p-0.5 bg-emerald-600 text-white rounded-md hover:bg-emerald-700"
                  >
                    <Plus size={12} />
                  </button>
                </div>
              )}
            </div>
          </div>

          {viewMode === "list" && !isBatchMode && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={(e) => { e.stopPropagation(); onView(); }}
                className="p-2 text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
                title="View"
              >
                <Maximize2 size={18} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setIsEditingTags(!isEditingTags); }}
                className="p-2 text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
                title="Tags"
              >
                <Tag size={18} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="p-2 text-stone-400 hover:text-red-500 transition-colors"
                title="Delete"
              >
                <Trash2 size={18} />
              </button>
            </div>
          )}
        </div>
        
        <p className="text-[10px] text-stone-400 dark:text-stone-500 uppercase tracking-wider font-medium mt-2">
          {new Date(photo.uploadDate).toLocaleDateString()}
        </p>
      </div>
    </motion.div>
  );
}

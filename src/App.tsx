import React, { useState, useEffect, useRef } from "react";
import { Upload, Tag, Trash2, Plus, X, Search, Image as ImageIcon, Loader2, Info, Download, Maximize2, CheckSquare, Square, Check, LayoutGrid, Grid3X3, Grid2X2, Files, Settings, Folder, FolderCheck } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import JSZip from "jszip";

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
}

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [uploadsDir, setUploadsDir] = useState<string>("");
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([]);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [gridSize, setGridSize] = useState<"sm" | "md" | "lg">("md");
  const [directoryHandle, setDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [dirPermissionStatus, setDirPermissionStatus] = useState<PermissionState | "prompt">("prompt");
  const [showSettings, setShowSettings] = useState(false);
  const [newUploadsDir, setNewUploadsDir] = useState("");
  const [isUpdatingUploadsDir, setIsUpdatingUploadsDir] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    
    try {
      // Upload files in parallel
      const uploadPromises = Array.from(files).map(async (file: File) => {
        const formData = new FormData();
        formData.append("photo", file);
        return fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
      });

      await Promise.all(uploadPromises);
      await fetchPhotos();
    } catch (error) {
      console.error("Upload failed:", error);
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
            <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white">
              <ImageIcon size={24} />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">PhotoSync</h1>
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
              <span className="hidden sm:inline">{uploading ? "Uploading..." : "Upload Photos"}</span>
            </button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleUpload}
              className="hidden"
              accept="image/*"
              multiple
            />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
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
                    </div>
                    <p className="text-[10px] text-stone-400 mt-2 italic">
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
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-stone-400" size={20} />
              <input
                type="text"
                placeholder="Search by name or tag..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-white border border-stone-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
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
            <button
              onClick={() => setGridSize("lg")}
              className={`p-2 rounded-xl transition-all ${gridSize === "lg" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-600"}`}
              title="Large Grid"
            >
              <Grid2X2 size={20} />
            </button>
            <button
              onClick={() => setGridSize("md")}
              className={`p-2 rounded-xl transition-all ${gridSize === "md" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-600"}`}
              title="Medium Grid"
            >
              <Grid3X3 size={20} />
            </button>
            <button
              onClick={() => setGridSize("sm")}
              className={`p-2 rounded-xl transition-all ${gridSize === "sm" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-600"}`}
              title="Small Grid"
            >
              <LayoutGrid size={20} />
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
              : "grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3"
          }`}>
            <AnimatePresence mode="popLayout">
              {filteredPhotos.map((photo) => (
                <PhotoCard
                  key={photo.id}
                  photo={photo}
                  onDelete={() => handleDelete(photo.id)}
                  onUpdateTags={(tags) => handleUpdateTags(photo.id, tags)}
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
                <img
                  src={`/uploads/${selectedPhoto.filename}`}
                  alt={selectedPhoto.originalName}
                  className="max-w-full max-h-full object-contain"
                  referrerPolicy="no-referrer"
                />
              </div>

              <div className="mt-4 w-full flex items-center justify-between text-white">
                <div>
                  <h3 className="text-lg font-medium">{selectedPhoto.originalName}</h3>
                  <div className="flex gap-2 mt-1">
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
                  className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-medium transition-colors"
                >
                  <Download size={20} />
                  Download
                </a>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface PhotoCardProps {
  key?: string | number;
  photo: Photo;
  onDelete: () => void | Promise<void>;
  onUpdateTags: (tags: string[]) => void | Promise<void>;
  onView: () => void;
  isSelected: boolean;
  onSelect: () => void;
  isBatchMode: boolean;
  directoryHandle: FileSystemDirectoryHandle | null;
  dirPermissionStatus: PermissionState | "prompt";
  requestDirPermission: () => Promise<boolean | undefined>;
  saveFileToDirectory: (filename: string, blob: Blob) => Promise<boolean>;
}

function PhotoCard({ photo, onDelete, onUpdateTags, onView, isSelected, onSelect, isBatchMode, directoryHandle, dirPermissionStatus, requestDirPermission, saveFileToDirectory }: PhotoCardProps) {
  const [isEditingTags, setIsEditingTags] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [downloading, setDownloading] = useState(false);

  const addTag = () => {
    if (newTag.trim() && !photo.tags.includes(newTag.trim())) {
      onUpdateTags([...photo.tags, newTag.trim()]);
      setNewTag("");
    }
  };

  const removeTag = (tagToRemove: string) => {
    onUpdateTags(photo.tags.filter(t => t !== tagToRemove));
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      onClick={() => isBatchMode && onSelect()}
      className={`group bg-white rounded-3xl overflow-hidden border transition-all cursor-pointer ${
        isSelected 
          ? "border-emerald-500 ring-2 ring-emerald-500/20 shadow-lg" 
          : "border-stone-200 shadow-sm hover:shadow-md"
      }`}
    >
      <div className="aspect-square relative overflow-hidden bg-stone-100">
        <img
          src={`/uploads/${photo.filename}`}
          alt={photo.originalName}
          className={`w-full h-full object-cover transition-transform duration-500 ${!isBatchMode && "group-hover:scale-110"}`}
          referrerPolicy="no-referrer"
        />
        
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
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
            <button
              onClick={(e) => { e.stopPropagation(); onView(); }}
              className="p-3 bg-white/20 backdrop-blur-md rounded-full text-white hover:bg-white/40 transition-colors"
              title="View Full Size"
            >
              <Maximize2 size={20} />
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
              className="p-3 bg-white/20 backdrop-blur-md rounded-full text-white hover:bg-white/40 transition-colors"
              title={directoryHandle ? `Save to ${directoryHandle.name}` : "Download (Choose location)"}
            >
              {downloading ? <Loader2 className="animate-spin" size={20} /> : <Download size={20} />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setIsEditingTags(!isEditingTags); }}
              className="p-3 bg-white/20 backdrop-blur-md rounded-full text-white hover:bg-white/40 transition-colors"
              title="Edit Tags"
            >
              <Tag size={20} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-3 bg-red-500/20 backdrop-blur-md rounded-full text-white hover:bg-red-500/40 transition-colors"
              title="Delete Photo"
            >
              <Trash2 size={20} />
            </button>
          </div>
        )}
      </div>

      <div className="p-4">
        <h4 className="font-medium text-stone-900 truncate mb-2" title={photo.originalName}>
          {photo.originalName}
        </h4>
        
        <div className="flex flex-wrap gap-1.5">
          {photo.tags.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-stone-100 text-stone-600 rounded-md text-xs font-medium"
            >
              {tag}
              {isEditingTags && (
                <button onClick={() => removeTag(tag)} className="hover:text-red-500">
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
          {isEditingTags && (
            <div className="flex items-center gap-1 mt-2 w-full">
              <input
                type="text"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addTag()}
                placeholder="Add tag..."
                className="flex-1 text-xs border border-stone-200 rounded-md px-2 py-1 focus:outline-none focus:border-emerald-500"
              />
              <button
                onClick={addTag}
                className="p-1 bg-emerald-600 text-white rounded-md hover:bg-emerald-700"
              >
                <Plus size={14} />
              </button>
            </div>
          )}
        </div>
        
        <p className="text-[10px] text-stone-400 mt-3 uppercase tracking-wider font-medium">
          {new Date(photo.uploadDate).toLocaleDateString()}
        </p>
      </div>
    </motion.div>
  );
}

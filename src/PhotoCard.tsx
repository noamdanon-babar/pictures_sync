import React, { useState } from "react";
import { Tag, Loader2, Download, Maximize2, Check, FolderCheck, Trash2, X, Plus } from "lucide-react";
import { motion } from "motion/react";
import { Photo } from "./App";

interface PhotoCardProps {
  photo: Photo;
  viewMode: "sm" | "md" | "lg" | "list";
  onDelete: () => void | Promise<void>;
  onUpdateTags: (tags: string[]) => void | Promise<void>;
  onRename: (newName: string) => void | Promise<void>;
  onView: () => void;
  onMove: () => void;
  isSelected: boolean;
  onSelect: () => void;
  isBatchMode: boolean;
  directoryHandle: FileSystemDirectoryHandle | null;
  dirPermissionStatus: PermissionState | "prompt";
  requestDirPermission: () => Promise<boolean | undefined>;
  saveFileToDirectory: (filename: string, blob: Blob) => Promise<boolean>;
}

export default function PhotoCard({ photo, viewMode, onDelete, onUpdateTags, onRename, onView, onMove, isSelected, onSelect, isBatchMode, directoryHandle, dirPermissionStatus, requestDirPermission, saveFileToDirectory }: PhotoCardProps) {
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
      className={`group bg-white rounded-2xl overflow-hidden border transition-all cursor-pointer ${
        isSelected 
          ? "border-emerald-500 ring-2 ring-emerald-500/20 shadow-lg"
          : "border-stone-200 shadow-sm hover:shadow-md"
      } ${viewMode === "list" ? "flex flex-row h-20" : "flex flex-col"}`}
    >
      <div className={`${viewMode === "list" ? "w-20 h-full" : "aspect-square"} relative overflow-hidden bg-stone-100 shrink-0`}>
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
                            description: "Media File",
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
              onClick={(e) => { e.stopPropagation(); onMove(); }}
              className={`${(viewMode === "list" || viewMode === "sm") ? "p-2" : "p-3"} bg-white/20 backdrop-blur-md rounded-full text-white hover:bg-white/40 transition-colors`}
              title="Move to Folder"
            >
              <FolderCheck size={(viewMode === "list" || viewMode === "sm") ? 16 : 20} />
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

      <div className={`${viewMode === "list" ? "p-3" : "p-4"} flex-1 flex flex-col justify-between ${viewMode === "list" ? "min-w-0" : ""}`}>
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
                  className="w-full px-2 py-0.5 text-sm bg-white border border-emerald-500 rounded outline-none"
                />
              </form>
            ) : (
              <h4 
                onClick={(e) => { e.stopPropagation(); setIsRenaming(true); }}
                className="font-medium text-stone-900 truncate mb-1 cursor-pointer hover:text-emerald-600 transition-colors" 
                title="Click to rename"
              >
                {photo.originalName}
              </h4>
            )}
            
            <div className="flex flex-wrap gap-1.5">
              {photo.tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-stone-100 text-stone-600 rounded-md text-[10px] font-medium"
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
                    className="flex-1 text-[10px] bg-white border border-stone-200 rounded-md px-2 py-0.5 focus:outline-none focus:border-emerald-500"
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
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={(e) => { e.stopPropagation(); onView(); }}
                className="p-1.5 text-stone-400 hover:text-stone-900 transition-colors"
                title="View"
              >
                <Maximize2 size={16} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setIsEditingTags(!isEditingTags); }}
                className="p-1.5 text-stone-400 hover:text-stone-900 transition-colors"
                title="Tags"
              >
                <Tag size={16} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onMove(); }}
                className="p-1.5 text-stone-400 hover:text-stone-900 transition-colors"
                title="Move"
              >
                <FolderCheck size={16} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="p-1.5 text-stone-400 hover:text-red-500 transition-colors"
                title="Delete"
              >
                <Trash2 size={16} />
              </button>
            </div>
          )}
        </div>
        
        <p className={`${viewMode === "list" ? "mt-1" : "mt-2"} text-[10px] text-stone-400 uppercase tracking-wider font-medium`}>
          {new Date(photo.uploadDate).toLocaleDateString()}
        </p>
      </div>
    </motion.div>
  );
}
import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORAGE_DIR = path.join(process.cwd(), "storage");
const CONFIG_FILE = path.join(STORAGE_DIR, "config.json");
const DATA_FILE = path.join(STORAGE_DIR, "data.json");

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Load or initialize config
let config = {
  uploadsDir: process.env.UPLOADS_PATH 
    ? path.resolve(process.env.UPLOADS_PATH) 
    : path.join(STORAGE_DIR, "uploads")
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    config = { ...config, ...savedConfig };
  } catch (e) {
    console.error("Failed to parse config.json", e);
  }
} else {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Ensure directories and files exist
if (!fs.existsSync(config.uploadsDir)) {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ photos: [], folders: [] }));
}

interface Photo {
  id: string;
  filename: string;
  originalName: string;
  tags: string[];
  uploadDate: string;
  type?: "image" | "video";
  folderId?: string | null;
}

interface Folder {
  id: string;
  name: string;
  createdAt: string;
}

interface Data {
  photos: Photo[];
  folders: Folder[];
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.uploadsDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-z0-9.]/gi, "_").toLowerCase();
    cb(null, `${timestamp}-${sanitizedName}`);
  },
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/config", (req, res) => {
    res.json({ uploadsDir: config.uploadsDir });
  });

  app.post("/api/config/uploads-dir", (req, res) => {
    const { uploadsDir } = req.body;
    if (!uploadsDir || typeof uploadsDir !== "string") {
      return res.status(400).json({ error: "Invalid uploads directory" });
    }

    const absolutePath = path.isAbsolute(uploadsDir) 
      ? uploadsDir 
      : path.resolve(process.cwd(), uploadsDir);

    try {
      if (!fs.existsSync(absolutePath)) {
        fs.mkdirSync(absolutePath, { recursive: true });
      }
      
      config.uploadsDir = absolutePath;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      
      res.json({ success: true, uploadsDir: config.uploadsDir });
    } catch (error) {
      console.error("Failed to update uploads directory:", error);
      res.status(500).json({ error: "Failed to update uploads directory" });
    }
  });

  app.post("/api/scan", (req, res) => {
    try {
      const { folderId } = req.body;
      if (!fs.existsSync(config.uploadsDir)) {
        return res.status(400).json({ 
          error: `Uploads directory does not exist: ${config.uploadsDir}. Please check your settings.` 
        });
      }

      const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      const existingFilenames = new Set(data.photos.map(p => p.filename));
      const files = fs.readdirSync(config.uploadsDir);
      
      const newPhotos: Photo[] = [];
      const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"];
      const videoExtensions = [".mp4", ".mov", ".webm", ".avi", ".mkv"];

      for (const file of files) {
        if (existingFilenames.has(file)) continue;

        const ext = path.extname(file).toLowerCase();
        const isImage = imageExtensions.includes(ext);
        const isVideo = videoExtensions.includes(ext);

        if (isImage || isVideo) {
          const stats = fs.statSync(path.join(config.uploadsDir, file));
          if (stats.isFile()) {
            newPhotos.push({
              id: uuidv4(),
              filename: file,
              originalName: file,
              tags: ["imported"],
              uploadDate: stats.mtime.toISOString(),
              type: isVideo ? "video" : "image",
              folderId: folderId || null
            });
          }
        }
      }

      if (newPhotos.length > 0) {
        data.photos.push(...newPhotos);
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
      }

      res.json({ 
        success: true, 
        count: newPhotos.length, 
        photos: newPhotos,
        scannedDir: config.uploadsDir
      });
    } catch (error) {
      console.error("Failed to scan directory:", error);
      res.status(500).json({ error: "Failed to scan directory. Ensure the server has access to the configured path." });
    }
  });

  app.get("/api/photos", (req, res) => {
    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    res.json(data.photos);
  });

  app.get("/api/folders", (req, res) => {
    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    res.json(data.folders || []);
  });

  app.post("/api/folders", (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Folder name is required" });

    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    if (!data.folders) data.folders = [];

    const newFolder: Folder = {
      id: uuidv4(),
      name,
      createdAt: new Date().toISOString()
    };

    data.folders.push(newFolder);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    res.json(newFolder);
  });

  app.patch("/api/folders/:id", (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Folder name is required" });

    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const folderIndex = data.folders.findIndex(f => f.id === id);
    if (folderIndex === -1) return res.status(404).json({ error: "Folder not found" });

    data.folders[folderIndex].name = name;
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    res.json(data.folders[folderIndex]);
  });

  app.delete("/api/folders/:id", (req, res) => {
    const { id } = req.params;
    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    
    // Remove folder
    data.folders = data.folders.filter(f => f.id !== id);
    
    // Move photos in this folder to root
    data.photos = data.photos.map(p => p.folderId === id ? { ...p, folderId: null } : p);
    
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
  });

  app.post("/api/photos/batch-move", (req, res) => {
    const { ids, folderId } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: "IDs must be an array" });

    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    let updatedCount = 0;

    data.photos = data.photos.map(photo => {
      if (ids.includes(photo.id)) {
        updatedCount++;
        return { ...photo, folderId: folderId || null };
      }
      return photo;
    });

    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true, updatedCount });
  });

  app.post("/api/upload", upload.single("photo"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { folderId } = req.body;
    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const newPhoto: Photo = {
      id: uuidv4(),
      filename: req.file.filename,
      originalName: req.file.originalname,
      tags: [],
      uploadDate: new Date().toISOString(),
      type: req.file.mimetype.startsWith("video/") ? "video" : "image",
      folderId: folderId || null,
    };

    data.photos.push(newPhoto);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

    console.log(`[PhotoSync] Saved: ${newPhoto.originalName} -> ${path.join(config.uploadsDir, newPhoto.filename)}`);

    res.json(newPhoto);
  });

  app.patch("/api/photos/:id/tags", (req, res) => {
    const { id } = req.params;
    const { tags } = req.body;

    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: "Tags must be an array" });
    }

    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const photoIndex = data.photos.findIndex((p) => p.id === id);

    if (photoIndex === -1) {
      return res.status(404).json({ error: "Photo not found" });
    }

    data.photos[photoIndex].tags = tags;
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

    res.json(data.photos[photoIndex]);
  });

  app.patch("/api/photos/:id/rename", (req, res) => {
    const { id } = req.params;
    const { newName } = req.body;

    if (!newName) {
      return res.status(400).json({ error: "New name is required" });
    }

    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const photoIndex = data.photos.findIndex((p) => p.id === id);

    if (photoIndex === -1) {
      return res.status(404).json({ error: "Photo not found" });
    }

    data.photos[photoIndex].originalName = newName;
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

    res.json(data.photos[photoIndex]);
  });

  app.delete("/api/photos/:id", (req, res) => {
    const { id } = req.params;
    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const photoIndex = data.photos.findIndex((p) => p.id === id);

    if (photoIndex === -1) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const photo = data.photos[photoIndex];
    const filePath = path.join(config.uploadsDir, photo.filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    data.photos.splice(photoIndex, 1);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

    res.json({ success: true });
  });

  app.post("/api/photos/batch-delete", (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: "IDs must be an array" });
    }

    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const initialCount = data.photos.length;
    
    const photosToDelete = data.photos.filter(p => ids.includes(p.id));
    
    for (const photo of photosToDelete) {
      const filePath = path.join(config.uploadsDir, photo.filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.error(`Failed to delete file ${filePath}`, e);
        }
      }
    }

    data.photos = data.photos.filter(p => !ids.includes(p.id));
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

    res.json({ 
      success: true, 
      deletedCount: initialCount - data.photos.length 
    });
  });

  app.post("/api/photos/batch-tags", (req, res) => {
    const { ids, tags } = req.body;
    if (!Array.isArray(ids) || !Array.isArray(tags)) {
      return res.status(400).json({ error: "IDs and tags must be arrays" });
    }

    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    let updatedCount = 0;

    data.photos = data.photos.map(photo => {
      if (ids.includes(photo.id)) {
        const newTags = Array.from(new Set([...photo.tags, ...tags]));
        updatedCount++;
        return { ...photo, tags: newTags };
      }
      return photo;
    });

    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true, updatedCount });
  });

  // Serve uploaded files
  app.use("/uploads", (req, res, next) => {
    express.static(config.uploadsDir)(req, res, next);
  });

  // Global error handler for multer and other errors
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[Server Error]:", err);
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    res.status(500).json({ error: "Internal server error during upload" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

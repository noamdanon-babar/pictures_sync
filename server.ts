import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = process.env.UPLOADS_PATH 
  ? path.resolve(process.env.UPLOADS_PATH) 
  : path.join(process.cwd(), "uploads");
const DATA_FILE = path.join(process.cwd(), "data.json");

// Ensure directories and files exist
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ photos: [] }));
}

interface Photo {
  id: string;
  filename: string;
  originalName: string;
  tags: string[];
  uploadDate: string;
}

interface Data {
  photos: Photo[];
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({ storage });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/config", (req, res) => {
    res.json({ uploadsDir: UPLOADS_DIR });
  });

  app.get("/api/photos", (req, res) => {
    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    res.json(data.photos);
  });

  app.post("/api/upload", upload.single("photo"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const newPhoto: Photo = {
      id: uuidv4(),
      filename: req.file.filename,
      originalName: req.file.originalname,
      tags: [],
      uploadDate: new Date().toISOString(),
    };

    data.photos.push(newPhoto);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

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

  app.delete("/api/photos/:id", (req, res) => {
    const { id } = req.params;
    const data: Data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const photoIndex = data.photos.findIndex((p) => p.id === id);

    if (photoIndex === -1) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const photo = data.photos[photoIndex];
    const filePath = path.join(UPLOADS_DIR, photo.filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    data.photos.splice(photoIndex, 1);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

    res.json({ success: true });
  });

  // Serve uploaded files
  app.use("/uploads", express.static(UPLOADS_DIR));

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

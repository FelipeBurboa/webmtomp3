// src/server.ts
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { pipeline } from "stream/promises";
import { createWriteStream, createReadStream } from "fs";
import { Readable } from "stream";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp";

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: true, // Allow all origins for development
    credentials: true,
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: "Too many conversion requests, please try again later",
});

app.use("/api/convert", limiter);
app.use(express.json());

// Types
interface ConversionRequest {
  url: string;
  outputFormat?: "mp3" | "wav" | "aac";
  bitrate?: string;
}

interface ConversionResponse {
  success: boolean;
  downloadUrl?: string;
  error?: string;
  fileId?: string;
}

// Utility functions
const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

const isValidAudioFormat = (format: string): boolean => {
  const validFormats = ["mp3", "wav", "aac"];
  return validFormats.includes(format);
};

const cleanupFile = async (filePath: string): Promise<void> => {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    console.error(`Failed to cleanup file ${filePath}:`, error);
  }
};

const downloadFile = async (url: string, outputPath: string): Promise<void> => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("No response body received");
  }

  const fileStream = createWriteStream(outputPath);

  // Convert Web ReadableStream to Node.js Readable stream
  const nodeReadable = Readable.fromWeb(response.body as any);
  await pipeline(nodeReadable, fileStream);
};

const convertAudio = async (
  inputPath: string,
  outputPath: string,
  outputFormat: string = "mp3",
  bitrate: string = "128k"
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      "-i",
      inputPath,
      "-acodec",
      outputFormat === "mp3"
        ? "libmp3lame"
        : outputFormat === "aac"
        ? "aac"
        : "pcm_s16le",
      "-ab",
      bitrate,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-y", // overwrite output file
      outputPath,
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    let errorOutput = "";

    ffmpeg.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg conversion failed with code ${code}: ${errorOutput}`
          )
        );
      }
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`FFmpeg spawn error: ${error.message}`));
    });
  });
};

// Routes
// @ts-ignore
app.post("/api/convert", async (req, res) => {
  const {
    url,
    outputFormat = "mp3",
    bitrate = "128k",
  }: ConversionRequest = req.body;

  // Validation
  if (!url) {
    return res.status(400).json({
      success: false,
      error: "URL is required",
    } as ConversionResponse);
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({
      success: false,
      error: "Invalid URL format",
    } as ConversionResponse);
  }

  if (!isValidAudioFormat(outputFormat)) {
    return res.status(400).json({
      success: false,
      error: "Invalid output format. Supported formats: mp3, wav, aac",
    } as ConversionResponse);
  }

  const fileId = uuidv4();
  const inputPath = path.join(UPLOAD_DIR, `${fileId}_input.webm`);
  const outputPath = path.join(UPLOAD_DIR, `${fileId}_output.${outputFormat}`);

  try {
    // Download the file
    console.log(`Downloading file from: ${url}`);
    await downloadFile(url, inputPath);

    // Convert the audio
    console.log(`Converting audio: ${inputPath} -> ${outputPath}`);
    await convertAudio(inputPath, outputPath, outputFormat, bitrate);

    // Check if output file exists
    const stats = await fs.stat(outputPath);
    if (!stats.isFile()) {
      throw new Error("Conversion failed - output file not created");
    }

    console.log(`Conversion successful: ${outputPath} (${stats.size} bytes)`);

    // Return success with download URL
    res.json({
      success: true,
      downloadUrl: `/api/download/${fileId}`,
      fileId,
    } as ConversionResponse);
  } catch (error) {
    console.error("Conversion error:", error);

    // Cleanup files on error
    await cleanupFile(inputPath);
    await cleanupFile(outputPath);

    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : "Unknown conversion error",
    } as ConversionResponse);
  } finally {
    // Always cleanup input file
    await cleanupFile(inputPath);
  }
});

// @ts-ignore
app.get("/api/download/:fileId", async (req, res) => {
  const { fileId } = req.params;

  if (!fileId || !/^[a-f0-9-]{36}$/.test(fileId)) {
    return res.status(400).json({
      success: false,
      error: "Invalid file ID",
    });
  }

  try {
    // Try to find the output file (check all supported formats)
    const formats = ["mp3", "wav", "aac"];
    let outputPath: string | null = null;
    let fileFormat: string | null = null;

    for (const format of formats) {
      const testPath = path.join(UPLOAD_DIR, `${fileId}_output.${format}`);
      try {
        await fs.access(testPath);
        outputPath = testPath;
        fileFormat = format;
        break;
      } catch {
        // File doesn't exist, continue
      }
    }

    if (!outputPath || !fileFormat) {
      return res.status(404).json({
        success: false,
        error: "File not found or expired",
      });
    }

    // Set appropriate headers
    const stats = await fs.stat(outputPath);
    const mimeTypes = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      aac: "audio/aac",
    };

    res.setHeader(
      "Content-Type",
      mimeTypes[fileFormat as keyof typeof mimeTypes]
    );
    res.setHeader("Content-Length", stats.size);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="converted_audio.${fileFormat}"`
    );

    // Stream the file
    const fileStream = createReadStream(outputPath);
    fileStream.pipe(res);

    // Cleanup file after streaming
    fileStream.on("end", async () => {
      await cleanupFile(outputPath!);
    });

    fileStream.on("error", (error) => {
      console.error("File stream error:", error);
      res.status(500).json({
        success: false,
        error: "Error streaming file",
      });
    });
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// Combined convert and download endpoint - ADD THIS
// @ts-ignore
app.post("/api/convert-download", async (req, res) => {
  const {
    url,
    outputFormat = "mp3",
    bitrate = "128k",
  }: ConversionRequest = req.body;

  // Validation
  if (!url) {
    return res.status(400).json({
      success: false,
      error: "URL is required",
    });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({
      success: false,
      error: "Invalid URL format",
    });
  }

  if (!isValidAudioFormat(outputFormat)) {
    return res.status(400).json({
      success: false,
      error: "Invalid output format. Supported formats: mp3, wav, aac",
    });
  }

  const fileId = uuidv4();
  const inputPath = path.join(UPLOAD_DIR, `${fileId}_input.webm`);
  const outputPath = path.join(UPLOAD_DIR, `${fileId}_output.${outputFormat}`);

  try {
    // Download the file
    console.log(`Downloading file from: ${url}`);
    await downloadFile(url, inputPath);

    // Convert the audio
    console.log(`Converting audio: ${inputPath} -> ${outputPath}`);
    await convertAudio(inputPath, outputPath, outputFormat, bitrate);

    // Check if output file exists
    const stats = await fs.stat(outputPath);
    if (!stats.isFile()) {
      throw new Error("Conversion failed - output file not created");
    }

    console.log(`Conversion successful: ${outputPath} (${stats.size} bytes)`);

    // Set headers for download
    const mimeTypes = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      aac: "audio/aac",
    };

    res.setHeader(
      "Content-Type",
      mimeTypes[outputFormat as keyof typeof mimeTypes]
    );
    res.setHeader("Content-Length", stats.size);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="converted_audio.${outputFormat}"`
    );

    // Stream the file directly to response
    const fileStream = createReadStream(outputPath);
    fileStream.pipe(res);

    // Cleanup files after streaming
    fileStream.on("end", async () => {
      await cleanupFile(inputPath);
      await cleanupFile(outputPath);
    });

    fileStream.on("error", (error) => {
      console.error("File stream error:", error);
      res.status(500).json({
        success: false,
        error: "Error streaming file",
      });
    });
  } catch (error) {
    console.error("Conversion error:", error);

    // Cleanup files on error
    await cleanupFile(inputPath);
    await cleanupFile(outputPath);

    // Return JSON error if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown conversion error",
      });
    }
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Error handling middleware
app.use(
  (
    error: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error("Unhandled error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
);

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
  });
});

// Cleanup old files on startup and periodically
const cleanupOldFiles = async (): Promise<void> => {
  try {
    const files = await fs.readdir(UPLOAD_DIR);
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour

    for (const file of files) {
      if (file.includes("_input.") || file.includes("_output.")) {
        const filePath = path.join(UPLOAD_DIR, file);
        const stats = await fs.stat(filePath);

        if (now - stats.mtime.getTime() > maxAge) {
          await cleanupFile(filePath);
          console.log(`Cleaned up old file: ${file}`);
        }
      }
    }
  } catch (error) {
    console.error("Cleanup error:", error);
  }
};

// Start server
app.listen(PORT, () => {
  console.log(`Audio conversion API running on port ${PORT}`);

  // Initial cleanup
  cleanupOldFiles();

  // Schedule periodic cleanup every 30 minutes
  setInterval(cleanupOldFiles, 30 * 60 * 1000);
});

export default app;

import { unzipSync } from "fflate";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { HttpError } from "./http";
export const maxResumeBytes = 5 * 1024 * 1024;
export async function extractResume(filename: string, bytes: Buffer) {
  if (!bytes.length || bytes.length > maxResumeBytes)
    throw new HttpError(400, "Choose a nonempty resume no larger than 5 MiB.");
  const extension = filename.split(".").pop()?.toLowerCase();
  let text = "";
  let mimeType = "text/plain";
  try {
    if (extension === "txt") {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw new Error("Binary file");
    } else if (extension === "pdf") {
      if (bytes.subarray(0, 5).toString() !== "%PDF-")
        throw new Error("Invalid PDF");
      mimeType = "application/pdf";
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      try {
        if (pdf.numPages > 30)
          throw new HttpError(400, "Resumes must have 30 pages or fewer.");
        text = (await extractText(pdf, { mergePages: true })).text;
      } finally {
        await pdf.loadingTask.destroy();
      }
    } else if (extension === "docx") {
      if (bytes.subarray(0, 2).toString() !== "PK")
        throw new Error("Invalid DOCX");
      mimeType =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      let expanded = 0;
      const entries = unzipSync(bytes, {
        filter(entry) {
          expanded += entry.originalSize;
          if (expanded > 20 * 1024 * 1024)
            throw new HttpError(400, "The expanded document is too large.");
          return false;
        },
      });
      void entries;
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else throw new HttpError(415, "Supported formats are TXT, PDF and DOCX.");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      "This document could not be read. Try an unencrypted PDF, DOCX or UTF-8 TXT file.",
    );
  }
  text = text.replace(/\0/g, "").trim();
  if (text.length < 20)
    throw new HttpError(
      400,
      "No readable resume text was found. Scanned PDFs need OCR before uploading.",
    );
  if (text.length > 200000)
    throw new HttpError(400, "The resume contains too much text.");
  return { text, mimeType };
}

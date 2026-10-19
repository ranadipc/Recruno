export type ExtractionStatus = "good" | "uncertain" | "poor";

export type ExtractionQuality = {
  status: ExtractionStatus;
  score: number;
  issues: string[];
  pageCount: number;
  pagesWithText: number;
  detectedColumns: number;
};

export type ResumeExtractionMethod =
  | "pdf-layout"
  | "docx-structured"
  | "doc-best-effort"
  | "none";

export type ResumeExtraction = {
  text: string;
  method: ResumeExtractionMethod;
  quality: ExtractionQuality;
};

type PositionedText = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type TextLine = {
  text: string;
  y: number;
  minX: number;
  maxX: number;
  height: number;
};

// PDF link labels often say only "Email" or "LinkedIn". Preserve the actual
// annotation targets so text-only grading can recover visible contact links.
export function resumeLinkTargets(annotations: Array<{ url?: unknown; unsafeUrl?: unknown }>): string[] {
  const targets = annotations.map(annotation => annotation.url ?? annotation.unsafeUrl)
    .filter((value): value is string => typeof value === "string")
    .map(value => value.trim())
    .filter(value => /^(?:https?:\/\/|mailto:|tel:)/i.test(value) && !/[\r\n\u0000]/.test(value));
  return [...new Set(targets)];
}

function extensionFor(fileName: string) {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

function cleanText(text: string) {
  return text
    .replace(/\u00ad/g, "")
    .replace(/([^\s])-\s*\n\s*([a-z])/g, "$1$2")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function joinLine(items: PositionedText[]) {
  const ordered = [...items].sort((a, b) => a.x - b.x);
  let output = "";
  let previous: PositionedText | undefined;
  let wideGaps = 0;

  for (const item of ordered) {
    const value = item.text.trim();
    if (!value) continue;
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      const wideGap = Math.max(18, Math.max(previous.height, item.height) * 1.75);
      if (gap > wideGap) {
        output += " | ";
        wideGaps += 1;
      } else if (gap > 1 && !output.endsWith(" ") && !/^[,.;:!?%)]/.test(value)) {
        output += " ";
      }
    }
    output += value;
    previous = item;
  }

  return wideGaps ? `[ROW] ${output}` : output;
}

function groupIntoLines(items: PositionedText[]) {
  const lines: PositionedText[][] = [];
  const ordered = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  for (const item of ordered) {
    const tolerance = Math.max(2, item.height * 0.45);
    const line = lines.find((candidate) => Math.abs(candidate[0].y - item.y) <= tolerance);
    if (line) line.push(item);
    else lines.push([item]);
  }

  return lines
    .map((line): TextLine => {
      const text = joinLine(line);
      return {
        text,
        y: line.reduce((sum, item) => sum + item.y, 0) / line.length,
        minX: Math.min(...line.map((item) => item.x)),
        maxX: Math.max(...line.map((item) => item.x + item.width)),
        height: Math.max(...line.map((item) => item.height))
      };
    })
    .filter((line) => line.text)
    .sort((a, b) => b.y - a.y || a.minX - b.minX);
}

function findColumnSplit(lines: TextLine[], pageWidth: number) {
  if (lines.length < 8 || pageWidth <= 0) return undefined;
  let best: { x: number; crossings: number } | undefined;

  for (let fraction = 0.3; fraction <= 0.7; fraction += 0.02) {
    const x = pageWidth * fraction;
    const left = lines.filter((line) => line.maxX < x - 4).length;
    const right = lines.filter((line) => line.minX > x + 4).length;
    const crossings = lines.length - left - right;
    if (left < 3 || right < 3) continue;
    if (!best || crossings < best.crossings) best = { x, crossings };
  }

  if (!best || best.crossings / lines.length > 0.2) return undefined;
  return best.x;
}

function orderPage(lines: TextLine[], pageWidth: number) {
  const split = findColumnSplit(lines, pageWidth);
  if (!split) return { text: lines.map((line) => line.text).join("\n"), columns: 0 };
  const columnSplit = split;

  const output: string[] = [];
  let segment: TextLine[] = [];

  function flushSegment() {
    if (!segment.length) return;
    const left = segment.filter((line) => (line.minX + line.maxX) / 2 < columnSplit).sort((a, b) => b.y - a.y);
    const right = segment.filter((line) => (line.minX + line.maxX) / 2 >= columnSplit).sort((a, b) => b.y - a.y);
    if (left.length) output.push("[LEFT COLUMN]", ...left.map((line) => line.text));
    if (right.length) output.push("[RIGHT COLUMN]", ...right.map((line) => line.text));
    segment = [];
  }

  for (const line of lines) {
    const spansGutter = line.minX < columnSplit - 4 && line.maxX > columnSplit + 4;
    if (spansGutter) {
      flushSegment();
      output.push(line.text);
    } else {
      segment.push(line);
    }
  }
  flushSegment();

  return { text: output.join("\n"), columns: 2 };
}

function duplicateLineRatio(text: string) {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length >= 12);
  if (lines.length < 4) return 0;
  const unique = new Set(lines.map((line) => line.toLowerCase()));
  return 1 - unique.size / lines.length;
}

function analyzeQuality(pages: string[], detectedColumns: number): ExtractionQuality {
  const text = cleanText(pages.join("\n"));
  const issues: string[] = [];
  const pagesWithText = pages.filter((page) => page.replace(/\s/g, "").length >= 30).length;
  let score = 100;

  if (!text) {
    return { status: "poor", score: 0, issues: ["No readable text was found."], pageCount: pages.length, pagesWithText: 0, detectedColumns };
  }

  if (text.length < 150) {
    score -= 45;
    issues.push("Very little text was extracted.");
  } else if (text.length < 400) {
    score -= 20;
    issues.push("The extracted text is unusually short.");
  }

  if (pages.length && pagesWithText < pages.length) {
    score -= Math.min(45, Math.round(((pages.length - pagesWithText) / pages.length) * 60));
    issues.push(`${pages.length - pagesWithText} page${pages.length - pagesWithText === 1 ? "" : "s"} returned little or no text.`);
  }

  const visibleCharacters = (text.match(/\S/gu) ?? []).length;
  const readableCharacters = (text.match(/[\p{L}\p{N}\s.,:;!?@+()'"/&%#|\-]/gu) ?? []).length;
  const readableRatio = visibleCharacters ? readableCharacters / text.length : 0;
  if (readableRatio < 0.55) {
    score -= 40;
    issues.push("A large part of the text contains unreadable symbols.");
  } else if (readableRatio < 0.7) {
    score -= 18;
    issues.push("Some text contains unusual or damaged symbols.");
  }

  if (/\uFFFD|([#@$%&*?])\1{2,}/u.test(text)) {
    score -= 20;
    issues.push("Repeated replacement symbols were detected.");
  }

  const words = text.match(/[\p{L}\p{N}+#.-]+/gu) ?? [];
  const singleCharacterWords = words.filter((word) => /^\p{L}$/u.test(word)).length;
  if (words.length > 20 && singleCharacterWords / words.length > 0.35) {
    score -= 18;
    issues.push("Many words appear to have been split into individual letters.");
  }

  const duplicates = duplicateLineRatio(text);
  if (duplicates > 0.3) {
    score -= 18;
    issues.push("A large amount of duplicate text was detected.");
  }

  const hasContact = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?\d[\d() .-]{7,}\d)/.test(text);
  if (!hasContact) {
    score -= 6;
    issues.push("No email address or phone number was detected.");
  }

  const hasResumeSection = /\b(experience|employment|education|skills|projects|certifications?|summary|profile|achievements?)\b/i.test(text);
  if (!hasResumeSection) {
    score -= 8;
    issues.push("No common resume section heading was detected.");
  }

  score = Math.max(0, Math.min(100, score));
  const status: ExtractionStatus = score >= 80 ? "good" : score >= 45 ? "uncertain" : "poor";
  return { status, score, issues, pageCount: pages.length, pagesWithText, detectedColumns };
}

function htmlToStructuredText(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");

  for (const table of Array.from(document.querySelectorAll("table"))) {
    const rows = Array.from(table.querySelectorAll("tr"))
      .map((row) => Array.from(row.querySelectorAll(":scope > th, :scope > td")).map((cell) => cleanText(cell.textContent ?? "")).filter(Boolean).join(" | "))
      .filter(Boolean);
    table.replaceWith(document.createTextNode(rows.map((row) => `[ROW] ${row}`).join("\n")));
  }

  for (const br of Array.from(document.querySelectorAll("br"))) br.replaceWith(document.createTextNode("\n"));
  for (const item of Array.from(document.querySelectorAll("li"))) item.insertBefore(document.createTextNode("- "), item.firstChild);
  for (const block of Array.from(document.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li"))) block.append(document.createTextNode("\n"));
  return cleanText(document.body.textContent ?? "");
}

async function extractPdf(blob: Blob): Promise<ResumeExtraction> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const document = await task.promise;
  const pages: string[] = [];
  let detectedColumns = 0;

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PositionedText[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        items.push({
          text: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
          height: Math.abs(item.height || item.transform[3] || 10)
        });
      }
      const ordered = orderPage(groupIntoLines(items), viewport.width);
      detectedColumns += ordered.columns ? 1 : 0;
      const links = resumeLinkTargets(await page.getAnnotations({ intent: "display" }));
      const newLinks = links.filter(link => !ordered.text.includes(link));
      pages.push(cleanText([ordered.text, ...(newLinks.length ? ["[PDF LINK TARGETS]", ...newLinks] : [])].join("\n")));
    }
  } finally {
    await task.destroy();
  }

  const text = cleanText(pages.map((page, index) => `[PAGE ${index + 1}]\n${page}`).join("\n\n"));
  return { text, method: "pdf-layout", quality: analyzeQuality(pages, detectedColumns) };
}

async function extractDocx(blob: Blob): Promise<ResumeExtraction> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
  const text = htmlToStructuredText(result.value);
  const quality = analyzeQuality([text], 0);
  if (result.messages.some((message) => message.type === "error")) {
    quality.score = Math.max(0, quality.score - 20);
    quality.status = quality.score >= 80 ? "good" : quality.score >= 45 ? "uncertain" : "poor";
    quality.issues.push("The DOCX reader reported damaged or unsupported content.");
  }
  return { text, method: "docx-structured", quality };
}

async function extractLegacyDoc(blob: Blob): Promise<ResumeExtraction> {
  const raw = new TextDecoder("latin1").decode(await blob.arrayBuffer());
  const text = cleanText(raw.replace(/\0/g, " ").replace(/[^\x20-\x7E\r\n\t]+/g, " "));
  const quality = analyzeQuality([text], 0);
  quality.score = Math.max(0, quality.score - 25);
  quality.status = quality.score >= 80 ? "good" : quality.score >= 45 ? "uncertain" : "poor";
  quality.issues.unshift("Legacy DOC files cannot preserve layout reliably; DOCX or PDF is recommended.");
  return { text, method: "doc-best-effort", quality };
}

export async function extractResumeDocument(blob: Blob, fileName: string): Promise<ResumeExtraction> {
  const extension = extensionFor(fileName);
  try {
    if (extension === "pdf") return await extractPdf(blob);
    if (extension === "docx") return await extractDocx(blob);
    if (extension === "doc") return await extractLegacyDoc(blob);
  } catch (error) {
    return {
      text: "",
      method: "none",
      quality: {
        status: "poor",
        score: 0,
        issues: [error instanceof Error ? `Text extraction failed: ${error.message}` : "Text extraction failed."],
        pageCount: 0,
        pagesWithText: 0,
        detectedColumns: 0
      }
    };
  }
  return {
    text: "",
    method: "none",
    quality: { status: "poor", score: 0, issues: ["Unsupported resume format."], pageCount: 0, pagesWithText: 0, detectedColumns: 0 }
  };
}

export async function renderPdfPagesAsImages(blob: Blob, maximumPages = 8) {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const document = await task.promise;
  const images: string[] = [];

  try {
    const pageLimit = Math.min(document.numPages, maximumPages);
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.max(1, Math.min(2.5, 1400 / baseViewport.width));
      const viewport = page.getViewport({ scale });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not prepare a page image.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      images.push(canvas.toDataURL("image/jpeg", 0.84));
    }
  } finally {
    await task.destroy();
  }

  return images;
}

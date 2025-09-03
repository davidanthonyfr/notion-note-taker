import React, { useCallback, useRef, useState } from "react";
import { createWorker } from "tesseract.js";
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/build/pdf.worker.mjs"; // make sure the worker is bundled

// In some environments you may need to set workerSrc explicitly.
// Vite usually handles it, but this keeps things robust.
try {
  // @ts-ignore
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
  ).toString();
} catch {}

/* ----------------------- helpers ----------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanText(t) {
  return (t || "")
    .replace(/\u00A0/g, " ") // nbsp
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sentenceSplit(t) {
  return cleanText(t)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s && s.length > 2);
}

function tokenize(t) {
  return cleanText(t)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set(
  "the a an and or of to in is are was were be been for with on at by from as that this these those into over under about after before between within without using use used than more most very much many can could should would may might not no yes if then when where how what who which also etc data info page slide figure table section chapter article".split(
    /\s+/
  )
);

function topTerms(t, k = 12) {
  const freq = new Map();
  for (const w of tokenize(t)) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([w]) => w);
}

function chunkOutline(text) {
  const lines = cleanText(text).split(/\n+/);
  const chunks = [];
  let buf = [];
  const push = (h, body) => chunks.push({ heading: h, body: body.join(" ") });
  for (const line of lines) {
    const isHeading =
      /^(\d+\.|\-|\•)?\s*[A-Z][A-Za-z0-9\s\-]{3,}$/.test(line) &&
      line.length < 80;
    if (isHeading) {
      if (buf.length) {
        push("Section", buf);
        buf = [];
      }
      chunks.push({ heading: line.trim(), body: "" });
    } else {
      buf.push(line.trim());
    }
  }
  if (buf.length) push("Section", buf);
  return chunks;
}

function keyTakeaways(text, n = 6) {
  const S = sentenceSplit(text);
  const scores = S.map((s) => {
    const words = tokenize(s);
    const uniq = new Set(words);
    return { s, score: uniq.size + Math.min(8, words.length) };
  });
  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(n, scores.length))
    .map((x) => x.s);
}

function guessTitle(text) {
  const firstLine = cleanText(text).split(/\n+/)[0] || "Notes";
  if (firstLine.length < 80) return firstLine.replace(/^[\-•\d.\s]+/, "");
  const terms = topTerms(text, 5).map((w) => w[0].toUpperCase() + w.slice(1));
  return terms.join(" • ") || "Notes";
}

function toMarkdown(allText) {
  const title = guessTitle(allText);
  const takeaways = keyTakeaways(allText);
  const outline = chunkOutline(allText);
  const terms = topTerms(allText, 12);

  const md = [
    `# ${title}`,
    "",
    "## Key Takeaways",
    ...takeaways.map((t) => `- ${t}`),
    "",
    "## Outline",
    ...outline.map((c) => `- **${c.heading}** — ${c.body.slice(0, 220)}`),
    "",
    "## Terms",
    `> ${terms.join(", ")}`
  ].join("\n");
  return md;
}

async function extractFromPDF(file) {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let text = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map((i) => i.str || "").join(" ");
    text += "\n\n" + pageText;
  }
  return cleanText(text);
}

async function extractFromImage(file, setStage) {
  const worker = await createWorker({ logger: () => {} });
  await worker.loadLanguage("eng");
  await worker.initialize("eng");
  setStage("Scanning image…");
  const { data } = await worker.recognize(file);
  await worker.terminate();
  return cleanText(data.text || "");
}

/* ----------------------- UI ----------------------- */
export default function App() {
  const [stage, setStage] = useState("Drop a PDF or image to begin");
  const [rawText, setRawText] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const handleFiles = useCallback(async (files) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setStage("Reading file…");
    let extracted = "";
    try {
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        extracted = await extractFromPDF(file);
      } else if (file.type.startsWith("image/")) {
        extracted = await extractFromImage(file, setStage);
      } else {
        throw new Error("Please provide a PDF or an image (PNG/JPG).");
      }
      setStage("Condensing notes…");
      await sleep(200);
      setRawText(extracted);
      setMarkdown(toMarkdown(extracted));
      setStage("Done ✔ Copy into Notion");
    } catch (e) {
      setStage("Error: " + (e?.message || "Failed to process file"));
    } finally {
      setBusy(false);
    }
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    if (busy) return;
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setStage("Copied! Paste into Notion with ⌘/Ctrl+V");
    } catch {
      setStage("Couldn’t auto-copy. Select all and copy manually.");
    }
  };

  const openFilePicker = () => inputRef.current?.click();

  return (
    <div style={{
      minHeight: "100vh",
      width: "100%",
      background: "#0a0a0a",
      color: "#e5e5e5",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24
    }}>
      <div style={{ width: "100%", maxWidth: 1100, display: "grid", gap: 16 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5 }}>Notion Note-Taker <span style={{ opacity: 0.6, fontSize: 12 }}>(MVP)</span></h1>
          <div>
            <button onClick={openFilePicker} disabled={busy}
              style={{ padding: "10px 14px", borderRadius: 14, background: "rgba(255,255,255,.1)", border: "1px solid rgba(255,255,255,.15)", color: "#fff", cursor: "pointer", opacity: busy ? .6 : 1 }}>
              Upload PDF / Image
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,image/*"
              style={{ display: "none" }}
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          style={{
            borderRadius: 24,
            border: "1px solid rgba(255,255,255,.12)",
            padding: 24,
            textAlign: "center",
            background: "rgba(255,255,255,.05)",
            backdropFilter: "blur(6px)"
          }}
        >
          <p style={{ opacity: .7, textTransform: "uppercase", fontSize: 12 }}>
            {busy ? "Working…" : "Drop here or click Upload"}
          </p>
          <p style={{ marginTop: 8, fontSize: 18, fontWeight: 600 }}>{stage}</p>
        </div>

        {/* Results */}
        {rawText && (
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr", }}>
            <div style={{ borderRadius: 24, border: "1px solid rgba(255,255,255,.12)", padding: 16, background: "rgba(0,0,0,.3)" }}>
              <h2 style={{ fontWeight: 600, marginBottom: 8 }}>Extracted Text</h2>
              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                style={{ width: "100%", height: 350, background: "rgba(0,0,0,.4)", borderRadius: 12, padding: 12, color: "#e5e5e5", border: "1px solid rgba(255,255,255,.1)" }}
              />
            </div>
            <div style={{ borderRadius: 24, border: "1px solid rgba(255,255,255,.12)", padding: 16, background: "rgba(0,0,0,.3)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <h2 style={{ fontWeight: 600 }}>Markdown Notes</h2>
                <button onClick={onCopy}
                  style={{ padding: "8px 12px", borderRadius: 12, background: "rgba(255,255,255,.1)", border: "1px solid rgba(255,255,255,.15)", color: "#fff", cursor: "pointer" }}>
                  Copy
                </button>
              </div>
              <textarea
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                style={{ width: "100%", height: 350, background: "rgba(0,0,0,.4)", borderRadius: 12, padding: 12, color: "#e5e5e5", border: "1px solid rgba(255,255,255,.1)" }}
              />
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ opacity: .7, fontSize: 12, lineHeight: 1.6 }}>
          <p>Tip: Paste the Markdown into Notion (then use “Turn into heading/bullets”) for a clean study sheet.</p>
          <p>Limitations: OCR can be imperfect on low-quality images; PDF extraction depends on embedded text availability.</p>
        </div>
      </div>
    </div>
  );
}

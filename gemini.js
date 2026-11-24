// Shared Gemini helpers used by the Orders scanner and the Purchase invoice scanner.

// Google retires Gemini models often; try these in order and use the first that works.
const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];

export async function fileToResizedBase64(file, maxDim = 1600, quality = 0.85){
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality).split(",")[1];
}

// A Firestore document can hold at most 1 MiB, so photos saved there are shrunk
// until the base64 text is under ~900 KB (leaves room for the other fields).
const MAX_STORED_B64 = 900000;
export async function compressForStorage(file){
  const attempts = [[1600, 0.8], [1600, 0.6], [1600, 0.45], [1200, 0.6], [1200, 0.45], [1000, 0.4]];
  let b64 = "";
  for (const [maxDim, quality] of attempts){
    b64 = await fileToResizedBase64(file, maxDim, quality);
    if (b64.length <= MAX_STORED_B64) return b64;
  }
  throw new Error("This photo is too large to save even after shrinking — try a simpler photo of just the invoice.");
}

export async function callGemini(key, b64, prompt){
  let lastErr = null;
  for (const model of GEMINI_MODELS){
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [ { text: prompt }, { inline_data: { mime_type: "image/jpeg", data: b64 } } ] }]
      })
    });
    if (resp.ok) return resp.json();
    const errBody = await resp.json().catch(()=>({}));
    const msg = (errBody.error && errBody.error.message) || ("HTTP " + resp.status);
    // model retired/unknown -> try the next one in the list
    if (resp.status === 404 || /no longer available|not found/i.test(msg)){ lastErr = new Error(msg); continue; }
    if (resp.status === 400 || resp.status === 403) throw new Error("API key problem: " + msg);
    if (resp.status === 429) throw new Error("Daily free limit reached — try again tomorrow or use a different key.");
    throw new Error(msg);
  }
  throw new Error("None of the known Gemini models are available anymore — the app needs a model-name update. (" + (lastErr ? lastErr.message : "") + ")");
}

// Pulls the JSON object out of a Gemini response (strips ``` fences if the model added them).
export function geminiJson(data){
  const text = (((data.candidates||[])[0]||{}).content||{}).parts?.map(p=>p.text||"").join("") || "";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

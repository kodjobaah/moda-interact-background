import { readFile } from "node:fs/promises";
import { parseBuffer } from "music-metadata";
import { expect, it } from "vitest";
import { transcriptionFilename } from "../../../src/services/speech-transcription.service.js";
it("parses real synthetic Ogg/Opus bytes using WhatsApp MIME without conversion", async()=>{
 const bytes=await readFile(new URL("../../fixtures/audio/synthetic-tone.ogg",import.meta.url));
 const metadata=await parseBuffer(bytes,{mimeType:"audio/ogg; codecs=opus"});
 expect(metadata.format.container).toBe("Ogg"); expect(metadata.format.codec).toBe("Opus");
 expect(metadata.format.duration).toBeCloseTo(0.5,1);
 expect(transcriptionFilename("audio/ogg; codecs=opus")).toBe("voice-note.ogg");
});

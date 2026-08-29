import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const notebookPath = path.join(root, "notebooks", "amedspor_colab_free_ltx_i2v.ipynb");
const notebook = JSON.parse(fs.readFileSync(notebookPath, "utf8")) as {
  metadata: { accelerator?: string };
  cells: Array<{ cell_type: string; source: string[] }>;
};
const source = notebook.cells.flatMap((cell) => cell.source).join("");

describe("free Colab I2V notebook", () => {
  it("requires CUDA and uses the real LTX image-to-video pipeline", () => {
    expect(notebook.metadata.accelerator).toBe("GPU");
    expect(source).toContain("torch.cuda.is_available()");
    expect(source).toContain('MODEL_ID = "Lightricks/LTX-Video"');
    expect(source).toContain("LTXImageToVideoPipeline.from_pretrained");
    expect(source).toContain("image=init_image");
    expect(source).toContain("BitsAndBytesConfig(load_in_8bit=True)");
    expect(source).toContain("pipe.encode_prompt");
    expect(source).toContain("pipe.text_encoder = None");
    expect(source).not.toContain("mock-provider");
  });

  it("generates a native-vertical 8n+1 temporal clip", () => {
    expect(source).toContain("WIDTH = 576");
    expect(source).toContain("HEIGHT = 1024");
    expect(source).toContain("NUM_FRAMES = 65");
    expect((65 - 1) % 8).toBe(0);
  });

  it("uses the product-in-cafe source and never loads the weekday lineup", () => {
    expect(source).toContain("public\" / \"cup_of_coffee_HD_preserved.png");
    expect(source).not.toContain("da543044-fe85-4845-8796-8b667d9594f9.png");
  });

  it("rejects frozen output and writes H.264 before adding official branding", () => {
    expect(source).toContain("mean_adjacent_delta");
    expect(source).toContain('codec="libx264"');
    expect(source).toContain("public\" / \"logo.png");
    expect(source).toContain("Amedspor’un maçlarının");
    expect(source).toContain("Tüm ürünlerde");
    expect(source).toContain("%21");
  });
});

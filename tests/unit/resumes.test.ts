import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractResume, maxResumeBytes } from "../../apps/web/lib/resumes";
describe("local resume extraction", () => {
  it("extracts a TXT document without interpreting markup", async () => {
    const text =
      "Executive leader with AWS and security experience. <script>not executable</script>";
    expect((await extractResume("resume.txt", Buffer.from(text))).text).toBe(
      text,
    );
  });
  it("rejects oversized, malformed and unsupported files", async () => {
    await expect(
      extractResume("resume.txt", Buffer.alloc(maxResumeBytes + 1)),
    ).rejects.toThrow();
    await expect(
      extractResume("resume.pdf", Buffer.from("This is not a PDF")),
    ).rejects.toThrow();
    await expect(
      extractResume("resume.exe", Buffer.from("Not an allowed document")),
    ).rejects.toThrow();
    await expect(
      extractResume("resume.txt", Buffer.from([255, 254, 0])),
    ).rejects.toThrow();
  });
  it("extracts actual DOCX XML from a deterministic fixture", async () => {
    const file = zipSync({
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "word/document.xml": strToU8(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Executive leader with cloud architecture and security experience.</w:t></w:r></w:p></w:body></w:document>',
      ),
    });
    expect(
      (await extractResume("resume.docx", Buffer.from(file))).text,
    ).toContain("cloud architecture");
  });
  it("rejects a compressed expansion bomb before extraction", async () => {
    const file = zipSync({
      "word/document.xml": new Uint8Array(21 * 1024 * 1024),
    });
    await expect(
      extractResume("resume.docx", Buffer.from(file)),
    ).rejects.toThrow("expanded document");
  });
  it("extracts a real text PDF", async () => {
    const content =
      "BT /F1 12 Tf 20 80 Td (Executive leader with cloud and security experience) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((obj, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((v) => String(v).padStart(10, "0") + " 00000 n ")
      .join(
        "\n",
      )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    expect(
      (await extractResume("resume.pdf", Buffer.from(pdf))).text,
    ).toContain("cloud and security");
  });
});

import type { ModFolderFile } from "@/lib/mods/mod-extractor";

export type ModDrop = File | ModFolderFile[];

/** File lists are only available during the drop event; collect entry handles before awaiting. */
export async function readModDrop(transfer: DataTransfer): Promise<ModDrop> {
  const files = Array.from(transfer.files);
  const entries = Array.from(transfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  const multipleArchives = files.length > 1 && files.some((file) => /\.(zip|rar|7z)$/i.test(file.name));
  if (multipleArchives) throw new Error("Importa un solo archivo comprimido por vez.");
  if (files.length === 1 && /\.(zip|rar|7z)$/i.test(files[0].name) && !entries.some((entry) => entry.isDirectory)) {
    return files[0];
  }

  if (!entries.some((entry) => entry.isDirectory)) {
    if (files.length) return files.length === 1 ? files[0] : files;
    throw new Error("No se encontraron archivos en la selección.");
  }

  const folderFiles: ModFolderFile[] = [];
  const walk = async (entry: FileSystemEntry) => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      folderFiles.push({ path: entry.fullPath, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // Chromium returns at most 100 entries per batch.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };

  for (const entry of entries) await walk(entry);
  if (!folderFiles.length) throw new Error("La carpeta está vacía.");
  return folderFiles;
}

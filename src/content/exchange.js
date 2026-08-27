/* =========================================================================
   exchange.js — import, export, and file backup.
   =========================================================================
   This file is deliberately byte-compatible with Better Trading's format, so
   your existing folder codes and backup .txt files import straight in. That
   compatibility is the whole reason it looks the way it does.

   A shared folder code is:   "<formatVersion>:" + base64(JSON)

     v1  no prefix at all,  loc = "type:slug"            (PoE 1 only)
     v2  "2:" prefix,       loc = "type:slug"            (UTF-8 safe base64)
     v3  "3:" prefix,       loc = "version:type:slug"    + a "ver" field

   The JSON uses three-letter keys to keep codes short:
     icn = icon slug, tit = title, ver = game version, trs = trades,
     loc = the packed location above.

   A backup file is those codes, one per line, with active folders above a
   twenty-hyphen fence and archived folders below it.
   ========================================================================= */

window.PH = window.PH || {};

PH.exchange = (() => {
  const SECTION_DELIMITER = "\n--------------------\n";
  const LINE_DELIMITER = "\n";

  /* btoa/atob only handle Latin-1, and folder titles contain emoji, so we
     round-trip through UTF-8 bytes first. */
  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function decodeBase64Utf8(base64) {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function serializeFolder(folder, trades) {
    const payload = {
      icn: folder.icon ?? "",
      tit: folder.title,
      ver: folder.version ?? "1",
      trs: trades.map((trade) => ({
        tit: trade.title,
        loc: `${trade.location.version}:${trade.location.type}:${trade.location.slug}`,
      })),
    };
    return `3:${encodeBase64(JSON.stringify(payload))}`;
  }

  function parseFormatVersion(code) {
    if (code.startsWith("2:")) return 2;
    if (code.startsWith("3:")) return 3;
    return 1;
  }

  /* Returns { folder, trades } or null. Never throws — a bad paste should
     show "that code looks wrong", not break the panel. */
  function deserializeFolder(code) {
    try {
      const trimmed = code.trim();
      if (!trimmed) return null;

      const formatVersion = parseFormatVersion(trimmed);
      const json = formatVersion >= 2
        ? decodeBase64Utf8(trimmed.slice(2))
        : atob(trimmed); // v1 predates UTF-8 support; Latin-1 is correct here

      const payload = JSON.parse(json);
      if (!payload || typeof payload.tit !== "string" || !Array.isArray(payload.trs)) {
        return null;
      }

      const folder = {
        title: payload.tit,
        icon: payload.icn || null,
        version: formatVersion >= 3 ? (payload.ver ?? "1") : "1",
        archivedAt: null,
      };

      const trades = payload.trs.map((entry) => {
        let version, type, slug;
        if (formatVersion >= 3) {
          [version, type, slug] = String(entry.loc).split(":");
        } else {
          version = "1";
          [type, slug] = String(entry.loc).split(":");
        }
        return {
          title: entry.tit ?? "Untitled",
          completedAt: null,
          location: { version: version || "1", type, slug },
        };
      }).filter((t) => t.location.type && t.location.slug);

      return { folder, trades };
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------- whole-file backup */

  async function generateBackupText() {
    const folders = await PH.store.getFolders();
    const active = [];
    const archived = [];

    for (const folder of folders) {
      const trades = await PH.store.getTrades(folder.id);
      const code = serializeFolder(folder, trades);
      (folder.archivedAt ? archived : active).push(code);
    }

    return [active.join(LINE_DELIMITER), archived.join(LINE_DELIMITER)]
      .join(SECTION_DELIMITER);
  }

  function downloadBackup(text) {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    /* Dated filename, unlike Better Trading's fixed one — so successive
       backups don't pile up as "(1)", "(2)" in your downloads folder. */
    const stamp = new Date().toISOString().slice(0, 10);
    link.download = `poe-trade-helper-backup-${stamp}.txt`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* Restore is additive: it appends folders and never deletes what you have.
     Import the same file twice and you get duplicates — that's the safe
     failure, and it's what Better Trading does too. */
  async function restoreFromText(text) {
    let restored = 0;
    let skipped = 0;

    const [activeSection = "", archivedSection = ""] = text.split(SECTION_DELIMITER);

    const sections = [
      { codes: activeSection.split(LINE_DELIMITER).filter(Boolean), archivedAt: null },
      {
        codes: archivedSection.split(LINE_DELIMITER).filter(Boolean),
        archivedAt: new Date().toUTCString(),
      },
    ];

    for (const section of sections) {
      for (const code of section.codes) {
        const parsed = deserializeFolder(code);
        if (!parsed) { skipped++; continue; }
        await importFolder(parsed, { archivedAt: section.archivedAt });
        restored++;
      }
    }

    return { restored, skipped };
  }

  async function importFolder({ folder, trades }, { archivedAt = null } = {}) {
    const saved = await PH.store.saveFolder({ ...folder, archivedAt });
    const withIds = trades.map((t) => ({ ...t, id: PH.store.newId() }));
    await PH.store.replaceTrades(saved.id, withIds);
    return saved;
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  return {
    serializeFolder, deserializeFolder, importFolder,
    generateBackupText, downloadBackup, restoreFromText, readFile,
  };
})();

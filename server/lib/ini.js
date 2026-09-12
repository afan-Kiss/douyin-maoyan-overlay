export function parseIni(text) {
  const root = { _sections: {} };
  let section = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;

    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim();
      if (!root._sections[section]) root._sections[section] = {};
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (section) {
      root._sections[section][key] = value;
    } else {
      root[key] = value;
    }
  }

  return root;
}

export function getIniValue(ini, section, key, fallback = "") {
  const sec = ini._sections?.[section];
  if (sec && sec[key] !== undefined && sec[key] !== "") return sec[key];
  if (ini[key] !== undefined && ini[key] !== "") return ini[key];
  return fallback;
}

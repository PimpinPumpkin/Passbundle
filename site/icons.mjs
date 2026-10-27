// The glyphs on the site's jewel tiles (<x-tile icon="..." tone="...">), in
// the apps' style: SVG path data on a 24 by 24 grid, stroked in white. The
// first group are the apps' own category and Health report glyphs
// (passbundle-clients, libs/common/src/vault/keykeeper/categories.ts and
// apps/web/src/app/keykeeper/health/report-tiles.ts), so a login looks the
// same on the site as in the vault; the rest are drawn for the site.
export const ICONS = {
  // The apps' glyphs.
  grid: "M4 4h7v7H4Z M13 4h7v7h-7Z M4 13h7v7H4Z M13 13h7v7h-7Z",
  key: "M8 14a4 4 0 1 1 3.87-5H21v3h-2v3h-3v-3h-4.13A4 4 0 0 1 8 14Z M7 10h.01",
  note: "M6 3h9l4 4v14H6Z M14 3v5h5 M9 12h7 M9 16h5",
  card: "M3 6h18v12H3Z M3 10h18 M7 15h4",
  identity:
    "M4 5h16v14H4Z M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M5.5 16c.6-1.8 2-2.8 3.5-2.8s2.9 1 3.5 2.8 M14 9h4 M14 13h4",
  terminal: "M3 5h18v14H3Z M7 10l3 2-3 2 M12 15h5",
  bank: "M3 9l9-5 9 5 M5 10v7 M9.5 10v7 M14.5 10v7 M19 10v7 M3 20h18",
  wifi: "M2.5 9a14 14 0 0 1 19 0 M5.5 12.5a9.5 9.5 0 0 1 13 0 M8.5 16a5 5 0 0 1 7 0 M12 19.5h.01",
  server: "M4 4h16v6H4Z M4 14h16v6H4Z M8 7h.01 M8 17h.01",
  license: "M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2Z M9 8h6 M9 12h6",
  globe:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M3 12h18 M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z",
  envelope: "M3 6h18v12H3Z M3 7l9 6 9-6",
  badge: "M12 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z M8.6 12.6 7 21l5-2.6 5 2.6-1.6-8.4",
  star: "M12 4l2.5 5 5.5.8-4 3.9.9 5.5L12 16.6 7.1 19.2l.9-5.5-4-3.9 5.5-.8Z",
  shield: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6Z M8.5 12l2.5 2.5 4.5-5",
  exposed: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6Z M12 8v5 M12 16.5h.01",
  reused: "M4 12a8 8 0 0 1 13.7-5.6L20 9 M20 4v5h-5 M20 12a8 8 0 0 1-13.7 5.6L4 15 M4 20v-5h5",
  weak: "M4 18a8 8 0 1 1 16 0 M12 18 8 13",
  phone: "M8 3h8v18H8Z M11 17.5h2",
  passkey:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M3 20c.8-3.4 3-5 6-5 1.5 0 2.8.4 3.8 1.2 M17 13a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z M17 18v3 M17 20h2",
  people:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M3 20c.8-3.4 3-5 6-5s5.2 1.6 6 5 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 15c1.6.7 2.6 2.4 3 5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 7v5l3 2",

  // Drawn for the site.
  console: "M3 4h18v16H3Z M3 9h18 M8 9v11 M11.5 13h6 M11.5 16.5h4",
  lifebuoy:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M5.6 5.6l3.6 3.6 M14.8 14.8l3.6 3.6 M18.4 5.6l-3.6 3.6 M9.2 14.8l-3.6 3.6",
  signin: "M10 17l5-5-5-5 M15 12H3 M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5",
  pulse: "M3 12h4l3-7 4 14 3-7h4",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z M9 13l2 2 4-4",
  history: "M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5 M3.5 4v4.5H8 M12 8v4.5l3 2",
  sliders: "M4 6h9 M17 6h3 M15 4v4 M4 12h3 M11 12h9 M9 10v4 M4 18h11 M19 18h1 M17 16v4",
  layers: "M12 3l9 5-9 5-9-5Z M3 13l9 5 9-5",
  list: "M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01",
  code: "M8 7l-5 5 5 5 M16 7l5 5-5 5 M13.5 5l-3 14",
  lock: "M6 11h12v10H6Z M8.5 11V8a3.5 3.5 0 0 1 7 0v3 M12 15v2",
  bolt: "M13 3 5 13h6l-1 8 8-10h-6Z",
  send: "M21 3 3 10.5l7 3 3 7.5Z M10 13.5 21 3",
  face: "M4 8V5a1 1 0 0 1 1-1h3 M16 4h3a1 1 0 0 1 1 1v3 M20 16v3a1 1 0 0 1-1 1h-3 M8 20H5a1 1 0 0 1-1-1v-3 M9 10h.01 M15 10h.01 M9.5 15a3.5 3.5 0 0 0 5 0",
  download: "M12 3v12 M7 10l5 5 5-5 M4 17v3h16v-3",
  fill: "M4 5h16v5H4Z M7 7.5h6 M12 13l7.5 3-3.2 1.2L15 20.5Z",
  sparkle: "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l2.5 2.5 M15.5 15.5 18 18 M6 18l2.5-2.5 M15.5 8.5 18 6",
  browser: "M3 5h18v14H3Z M3 9h18 M6 7h.01 M9 7h.01",
  desktop: "M3 4h18v12H3Z M8 20h8 M12 16v4",
  laptop: "M5 5h14v10H5Z M2.5 19h19 M4 15l-1.5 4 M20 15l1.5 4",
  eyeoff:
    "M3 3l18 18 M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.2 9.5 6-.4.8-1.2 2-2.4 3.2 M6.5 7.6C4.6 8.9 3.2 10.7 2.5 12c1 1.8 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1 M9.9 9.9a3 3 0 0 0 4.2 4.2",
  usershield: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M3 20c.8-3.4 3-5 6-5 1.2 0 2.2.2 3.1.7 M17.5 12l3.5 1.4v2.8c0 2.1-1.5 3.6-3.5 4.3-2-.7-3.5-2.2-3.5-4.3v-2.8Z",
  coins: "M4 7c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3Z M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7 M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5",
  at: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1",
  chat: "M4 5h16v11H9l-5 4Z M8 9.5h8 M8 12.5h5",
  import: "M14 3h5v18h-5 M3 12h11 M10 8l4 4-4 4",
};

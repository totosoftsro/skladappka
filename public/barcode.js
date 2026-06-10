/* Minimální Code128 (sada B) generátor → SVG. window.Code128(text, {module,height}) */
(function () {
  // Šířkové vzory pro hodnoty 0–106 (106 = STOP). Standardní tabulka Code128.
  const P = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112'
  ];

  function encodeB(text) {
    const vals = [];
    for (const ch of String(text)) {
      const v = ch.charCodeAt(0);
      if (v < 32 || v > 126) throw new Error('Code128: nepodporovaný znak ' + JSON.stringify(ch)); // ať štítek neskenuje jiný kód, než ukazuje
      vals.push(v - 32);
    }
    if (!vals.length) vals.push(0);
    const codes = [104]; // Start B
    let sum = 104;
    vals.forEach((v, i) => { codes.push(v); sum += v * (i + 1); });
    codes.push(sum % 103); // kontrolní znak
    codes.push(106);       // STOP
    return codes;
  }

  function Code128(text, opt) {
    opt = opt || {};
    const mod = opt.module || 2, height = opt.height || 60, quiet = 10 * mod;
    const codes = encodeB(text);
    const rects = [];
    let x = quiet, bar = true;
    for (const c of codes) {
      for (const wch of P[c]) { const w = parseInt(wch, 10) * mod; if (bar) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`); x += w; bar = !bar; }
      bar = true; // každý znak začíná čárou
    }
    const width = x + quiet;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><rect width="${width}" height="${height}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
  }
  window.Code128 = Code128;
})();

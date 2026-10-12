// 乔木封面字库(主进程与渲染层共用):12 套「标题 / 正文 / 英文」搭配与文件表。
// 主进程负责按需下载与子集化;渲染层只用它做搭配选择与预览字体栈。
export const FONT_LIBRARY_VERSION = "1.0.0";
export const FONT_INDEX_URL = `https://cdn.jsdelivr.net/gh/joeseesun/qiaomu-cover-fonts@${FONT_LIBRARY_VERSION}/index.json`;
export const FONT_FILE_BASE = `https://cdn.jsdelivr.net/gh/joeseesun/qiaomu-cover-fonts@${FONT_LIBRARY_VERSION}/fonts/`;

export const FONT_FILES = Object.freeze({
  notosans: "notosans.woff2",
  "notosans-bold": "notosans-bold.woff2",
  "notosans-heavy": "notosans-heavy.woff2",
  notoserif: "notoserif.woff2",
  "notoserif-bold": "notoserif-bold.woff2",
  "notoserif-heavy": "notoserif-heavy.woff2",
  zhuque: "zhuque.woff2",
  wenkai: "wenkai.woff2",
  smiley: "smiley.woff2",
  glow: "glow.woff2",
  huangyou: "huangyou.woff2",
  jiangcheng: "jiangcheng.woff2",
  maoken: "maoken.woff2",
  tiejili: "tiejili.woff2",
  mashan: "mashan.woff2",
  cormorant: "cormorant.woff2",
  inter: "inter.woff2",
  "inter-bold": "inter-bold.woff2",
  spacegrotesk: "spacegrotesk.woff2",
  bricolage: "bricolage.woff2",
  fraunces: "fraunces.woff2",
  instrument: "instrument.woff2",
  archivoblack: "archivoblack.woff2",
  jetbrains: "jetbrains.woff2",
});

// 文件内部家族名(WOFF2 里的 name 表;预览字体栈与 @font-face 都用它)。
export const FONT_FAMILIES = Object.freeze({
  notosans: "Noto Sans SC",
  "notosans-bold": "Noto Sans SC",
  "notosans-heavy": "Noto Sans SC",
  notoserif: "Noto Serif SC",
  "notoserif-bold": "Noto Serif SC",
  "notoserif-heavy": "Noto Serif SC",
  zhuque: "Zhuque Fangsong (technical preview)",
  wenkai: "LXGW WenKai",
  smiley: "Smiley Sans Oblique",
  glow: "Glow Sans SC",
  huangyou: "ZCOOL QingKe HuangYou",
  jiangcheng: "JiangCheng YuanTi",
  maoken: "MaokenAssortedSans",
  tiejili: "Tiejili",
  mashan: "Ma Shan Zheng",
  cormorant: "Cormorant Garamond",
  inter: "Inter",
  "inter-bold": "Inter",
  spacegrotesk: "Space Grotesk",
  bricolage: "Bricolage Grotesque",
  fraunces: "Fraunces",
  instrument: "Instrument Serif",
  archivoblack: "Archivo Black",
  jetbrains: "JetBrains Mono",
});

// 12 套搭配(标题 / 正文 / 英文三角色),沿用字库 pairing。
export const FONT_PAIRINGS = Object.freeze([
  { id: "quiet", label: "安静正文", heading: "notosans-bold", body: "notoserif", latin: "inter" },
  { id: "literary", label: "文化书卷", heading: "zhuque", body: "wenkai", latin: "cormorant" },
  { id: "warm", label: "温暖手记", heading: "wenkai", body: "notosans", latin: "fraunces" },
  { id: "editorial", label: "编辑杂志", heading: "notoserif-heavy", body: "notosans", latin: "instrument" },
  { id: "tech", label: "科技产品", heading: "glow", body: "notosans", latin: "spacegrotesk" },
  { id: "guofeng", label: "国风书法", heading: "mashan", body: "zhuque", latin: "cormorant" },
  { id: "punch", label: "干货冲击", heading: "notosans-heavy", body: "notosans", latin: "archivoblack" },
  { id: "trend", label: "潮流种草", heading: "smiley", body: "notosans", latin: "bricolage" },
  { id: "soft", label: "圆润亲切", heading: "jiangcheng", body: "notosans", latin: "fraunces" },
  { id: "playful", label: "俏皮可爱", heading: "maoken", body: "notosans", latin: "bricolage" },
  { id: "promo", label: "促销亲切", heading: "huangyou", body: "notosans", latin: "archivoblack" },
  { id: "guochao", label: "国潮热血", heading: "tiejili", body: "notosans", latin: "bricolage" },
]);

export function findPairing(id) {
  return FONT_PAIRINGS.find((pairing) => pairing.id === String(id || "")) || FONT_PAIRINGS[0];
}

export function fontFileName(id) {
  return FONT_FILES[String(id || "")] || "";
}

// 预览用的字体栈:标题 / 正文 / 英文分别给 stack(带回退)。
export function pairingStacks(pairing) {
  const pair = pairing || FONT_PAIRINGS[0];
  const family = (id) => (id ? `'${FONT_FAMILIES[id] || id}'` : "");
  const heading = [family(pair.heading), "Georgia", "serif"].filter(Boolean).join(", ");
  const body = [family(pair.body), "Georgia", "'Songti SC'", "serif"].filter(Boolean).join(", ");
  const latin = [family(pair.latin), "Georgia", "serif"].filter(Boolean).join(", ");
  return { heading, body, latin };
}

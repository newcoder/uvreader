// Desktop shell defaults written into a fresh profile before the reader loads.
// These are real values, not "undefined means true": the settings page and the
// workshop code can read them without each place inventing its own fallback.
export const DEFAULT_POLISH_TAG = "精修";

export const DESKTOP_DATA_DEFAULTS = Object.freeze({
  onboarded: true,
  language: "zh",
  bookNotesFolder: "notes",
  dataFolder: "plugin",
  // 书坊随应用安装:默认打开,引擎随应用启动(内置引擎在第一次启动时解压)。
  workshopEnabled: true,
  engineAutoStart: true,
  engineUrl: "",
  engineToken: "",
  // 精修产物默认用“精修”做后缀,原文件永不覆盖。
  polishTag: DEFAULT_POLISH_TAG,
  // 本地 MinerU 常驻服务默认关闭;CLI 路径和地址留给自动发现。
  mineruLocalExe: "",
  mineruLocalUrl: "",
  mineruLocalAutoStart: false,
});

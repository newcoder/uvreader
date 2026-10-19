"""LaTeX（MinerU 公式 span）→ 可搜索的 Unicode 纯文本。

目标不是排版还原，而是让文字层里的公式能被常规输入命中：
`2\\mathrm{m}/{\\mathrm{s}}^{2}` → `2m/s²`，`\\frac{n_1}{n_2}` → `n₁/n₂`。
无法映射的结构（矩阵、复杂积分）退化为去掉命令的近似文本，不引入 LaTeX 原文。
"""
from __future__ import annotations

import re

SUP_TRANS = str.maketrans("0123456789+-=()ni", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ")
SUB_TRANS = str.maketrans("0123456789+-=()aeoxhklmnpst", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ")

_SYMBOLS: dict[str, str] = {
    r"\alpha": "α", r"\beta": "β", r"\gamma": "γ", r"\delta": "δ", r"\epsilon": "ε",
    r"\varepsilon": "ε", r"\zeta": "ζ", r"\eta": "η", r"\theta": "θ", r"\vartheta": "ϑ",
    r"\iota": "ι", r"\kappa": "κ", r"\lambda": "λ", r"\mu": "μ", r"\nu": "ν",
    r"\xi": "ξ", r"\pi": "π", r"\rho": "ρ", r"\sigma": "σ", r"\tau": "τ",
    r"\upsilon": "υ", r"\phi": "φ", r"\varphi": "φ", r"\chi": "χ", r"\psi": "ψ",
    r"\omega": "ω", r"\Gamma": "Γ", r"\Delta": "Δ", r"\Theta": "Θ", r"\Lambda": "Λ",
    r"\Xi": "Ξ", r"\Pi": "Π", r"\Sigma": "Σ", r"\Upsilon": "Υ", r"\Phi": "Φ",
    r"\Psi": "Ψ", r"\Omega": "Ω",
    r"\times": "×", r"\div": "÷", r"\cdot": "·", r"\pm": "±", r"\mp": "∓",
    r"\leq": "≤", r"\le": "≤", r"\geq": "≥", r"\ge": "≥", r"\neq": "≠", r"\ne": "≠",
    r"\approx": "≈", r"\equiv": "≡", r"\propto": "∝", r"\infty": "∞",
    r"\rightarrow": "→", r"\to": "→", r"\leftarrow": "←", r"\Rightarrow": "⇒",
    r"\Leftrightarrow": "⇔", r"\in": "∈", r"\notin": "∉", r"\subset": "⊂",
    r"\subseteq": "⊆", r"\supset": "⊃", r"\cup": "∪", r"\cap": "∩", r"\emptyset": "∅",
    r"\forall": "∀", r"\exists": "∃", r"\nabla": "∇", r"\partial": "∂",
    r"\sum": "∑", r"\prod": "∏", r"\int": "∫", r"\oint": "∮", r"\sqrt": "√",
    r"\angle": "∠", r"\perp": "⊥", r"\parallel": "∥", r"\sim": "∼",
    r"\bullet": "•", r"\circ": "∘", r"\degree": "°", r"\prime": "′", r"\ldots": "…",
    r"\dots": "…", r"\cdots": "⋯", r"\quad": " ", r"\qquad": " ",
}

# 只保留内容、去掉命令的包裹形式
_WRAPPERS = ("mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal",
             "boldsymbol", "text", "textbf", "textit", "textrm", "operatorname")
_WRAP_RE = re.compile(r"\\(?:" + "|".join(_WRAPPERS) + r")\s*\{([^{}]*)\}")
_FRAC_RE = re.compile(r"\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}")
_SQRT_RE = re.compile(r"\\sqrt\s*\{([^{}]*)\}")
_ENV_RE = re.compile(r"\\begin\{[^{}]*\}|\\end\{[^{}]*\}")
_SPACING_RE = re.compile(r"\\[,;:!>]|\\quad|\\qquad|\\ ")
_SUP_BRACE_RE = re.compile(r"\^\s*\{([^{}]*)\}")
_SUP_CHAR_RE = re.compile(r"\^\s*(\S)")
_SUB_BRACE_RE = re.compile(r"_\s*\{([^{}]*)\}")
_SUB_CHAR_RE = re.compile(r"_\s*(\S)")


def _to_script(body: str, trans: dict[int, str], fallback: str) -> str:
    """全部字符可映射则转 Unicode 上下标，否则退回原文本（去括号）。"""
    if body and all(ord(c) in trans for c in body):
        return body.translate(trans)
    return f"{fallback}{body}" if body else ""


def latex_to_text(s: str) -> str:
    """LaTeX 片段 → 纯文本；幂等、不抛异常（无法解析的命令按原名保留）。"""
    t = str(s or "")
    t = _ENV_RE.sub(" ", t)
    t = _SPACING_RE.sub(" ", t)
    t = t.replace(r"\\", " ").replace("~", " ")
    for _ in range(4):  # 先剥包裹命令（\frac 参数里也可能有），再展开分式
        new = _WRAP_RE.sub(r"\1", t)
        if new == t:
            break
        t = new
    for _ in range(4):  # 嵌套分式有限次展开
        new = _FRAC_RE.sub(r"\1/\2", t)
        if new == t:
            break
        t = new
    t = _SQRT_RE.sub(r"√(\1)", t)
    t = _WRAP_RE.sub(r"\1", t)
    for k, v in _SYMBOLS.items():
        t = t.replace(k, v)
    t = _SUP_BRACE_RE.sub(lambda m: _to_script(m.group(1), SUP_TRANS, "^"), t)
    t = _SUP_CHAR_RE.sub(lambda m: _to_script(m.group(1), SUP_TRANS, "^"), t)
    t = _SUB_BRACE_RE.sub(lambda m: _to_script(m.group(1), SUB_TRANS, "_"), t)
    t = _SUB_CHAR_RE.sub(lambda m: _to_script(m.group(1), SUB_TRANS, "_"), t)
    t = t.replace("$", "").replace("{", "").replace("}", "")
    return re.sub(r"\s+", " ", t).strip()

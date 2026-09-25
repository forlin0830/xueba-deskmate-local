import type { ElementType } from "react";

const symbolMap: Record<string, string> = {
  "\\times": "×", "\\div": "÷", "\\cdot": "·", "\\pm": "±", "\\mp": "∓",
  "\\leq": "≤", "\\le": "≤", "\\geq": "≥", "\\ge": "≥", "\\neq": "≠", "\\ne": "≠",
  "\\approx": "≈", "\\equiv": "≡", "\\infty": "∞", "\\pi": "π", "\\theta": "θ",
  "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\lambda": "λ", "\\mu": "μ",
  "\\Delta": "Δ", "\\delta": "δ", "\\sum": "∑", "\\prod": "∏", "\\int": "∫",
  "\\partial": "∂", "\\nabla": "∇", "\\to": "→", "\\rightarrow": "→", "\\Rightarrow": "⇒",
  "\\in": "∈", "\\notin": "∉", "\\subset": "⊂", "\\subseteq": "⊆", "\\cup": "∪", "\\cap": "∩",
  "\\because": "∵", "\\therefore": "∴", "\\perp": "⊥", "\\parallel": "∥", "\\angle": "∠",
};

const superscripts: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "n": "ⁿ" };
const subscripts: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋" };

function script(value: string, map: Record<string, string>, fallback: string): string {
  return [...value].every((character) => map[character]) ? [...value].map((character) => map[character]).join("") : fallback + "(" + value + ")";
}

export function normalizeMathText(value: string): string {
  let text = value
    .replace(/\$\$?/g, "")
    .replace(/\\[\[\]()]/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\\operatorname\{([^{}]*)\}/g, "$1");
  for (let pass = 0; pass < 3; pass += 1) {
    text = text
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
      .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");
  }
  for (const [latex, symbol] of Object.entries(symbolMap)) text = text.replaceAll(latex, symbol);
  return text
    .replace(/\^\{([^{}]+)\}/g, (_, value: string) => script(value, superscripts, "^"))
    .replace(/\^([0-9n])/g, (_, value: string) => superscripts[value] || "^" + value)
    .replace(/_\{([^{}]+)\}/g, (_, value: string) => script(value, subscripts, "_"))
    .replace(/_([0-9])/g, (_, value: string) => subscripts[value] || "_" + value)
    .replace(/\\,/g, " ")
    .replace(/\\;/g, " ")
    .replace(/\\!/g, "")
    .replace(/\\\{/g, "{")
    .replace(/\\\}/g, "}")
    .replace(/\\([A-Za-z]+)/g, "$1");
}

export function MathText({ children, as: Tag = "span", className }: { children: string; as?: ElementType; className?: string }) {
  return <Tag className={["math-text", className].filter(Boolean).join(" ")}>{normalizeMathText(children)}</Tag>;
}

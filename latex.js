'use strict';

// 把论文标题里 $...$ 之间的 LaTeX 公式转成 Unicode 文字，例如
//   ${\text{CA}^{2}\text{ST}}$  →  CA²ST
//   $\beta $-DARTS++            →  β-DARTS++
//   $\ell _{0}$ℓ0-Regularized   →  ℓ₀-Regularized（去掉紧跟在公式后面的重复纯文本）
const latexToUnicode = (() => {
  const SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
    varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
    varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
    Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    ell: 'ℓ', infty: '∞', partial: '∂', nabla: '∇', times: '×', cdot: '·', pm: '±', mp: '∓', div: '÷',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼', simeq: '≃',
    equiv: '≡', propto: '∝', ll: '≪', gg: '≫', to: '→', rightarrow: '→', leftarrow: '←',
    leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦',
    in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅',
    forall: '∀', exists: '∃', neg: '¬', wedge: '∧', vee: '∨', oplus: '⊕', otimes: '⊗', circ: '∘',
    star: '⋆', ast: '∗', dagger: '†', sum: '∑', prod: '∏', int: '∫', oint: '∮', sqrt: '√',
    ldots: '…', cdots: '⋯', dots: '…', prime: '′', degree: '°', hbar: 'ℏ', aleph: 'ℵ',
    langle: '⟨', rangle: '⟩', lvert: '|', rvert: '|', vert: '|', mid: '|', Vert: '‖',
    log: 'log', ln: 'ln', exp: 'exp', min: 'min', max: 'max', sin: 'sin', cos: 'cos', tan: 'tan',
    arg: 'arg', det: 'det', dim: 'dim', lim: 'lim', sup: 'sup', inf: 'inf',
    textendash: '–', textemdash: '—', S: '§', AA: 'Å', aa: 'å', o: 'ø', O: 'Ø', ss: 'ß',
  };
  // 参数原样当作文字的命令
  const TEXT_COMMANDS = new Set([
    'text', 'textrm', 'textnormal', 'mathrm', 'textbf', 'mathbf', 'textit', 'mathit', 'emph', 'textsf',
    'mathsf', 'texttt', 'mathtt', 'boldsymbol', 'bm', 'operatorname', 'mbox', 'hbox', 'textsc',
  ]);
  const ACCENTS = {
    hat: '̂', widehat: '̂', tilde: '̃', widetilde: '̃', bar: '̄',
    overline: '̅', vec: '⃗', dot: '̇', ddot: '̈',
  };
  const IGNORED = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'displaystyle', 'limits', 'nolimits']);

  const SUPER = mapOf('0123456789+-=()abcdefghijklmnoprstuvwxyzABDEGHIJKLMNOPRTUVW',
    '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ');
  const SUB = mapOf('0123456789+-=()aehijklmnoprstuvx', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ');
  const SCRIPT = mapOf('ABCDEFGHIJKLMNOPQRSTUVWXYZ', '𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵');
  const DOUBLE = mapOf('CHNPQRZ', 'ℂℍℕℙℚℝℤ');
  // 把上下标字符还原成普通字符，用来识别公式后面重复的纯文本
  const PLAIN = new Map([...SUPER, ...SUB].filter(([k, v]) => k !== v).map(([k, v]) => [v, k]));

  function mapOf(from, to) {
    const a = [...from];
    const b = [...to];
    // 逗号、星号等没有上下标形式，原样保留（如 L₂,₁、A*）
    return new Map([...a.map((c, i) => [c, b[i]]), [',', ','], ['*', '*'], ["'", '′'], ['′', '′']]);
  }

  function script(text, table, marker) {
    const chars = [...text];
    if (chars.length && chars.every((c) => table.has(c))) return chars.map((c) => table.get(c)).join('');
    if (!marker) return text;
    return chars.length > 1 ? `${marker}(${text})` : `${marker}${text}`;
  }

  // 递归转换一段公式；mathMode 下忽略空格
  function convert(src, mathMode) {
    let i = 0;
    let out = '';

    function skipSpaces() {
      while (i < src.length && /\s/.test(src[i])) i++;
    }

    // 读取一个参数：{...}、\命令 或单个字符，返回原始文本
    function readRaw() {
      skipSpaces();
      if (src[i] === '{') {
        let depth = 0;
        const start = i;
        for (; i < src.length; i++) {
          if (src[i] === '\\') { i++; continue; }
          if (src[i] === '{') depth++;
          else if (src[i] === '}' && --depth === 0) { i++; return src.slice(start + 1, i - 1); }
        }
        return src.slice(start + 1);
      }
      if (src[i] === '\\') {
        const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i));
        if (m) { i += m[0].length; return m[0]; }
      }
      return src[i++] || '';
    }

    const readArg = () => convert(readRaw(), mathMode);

    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) {
        i++;
        if (!mathMode && !out.endsWith(' ')) out += ' ';
      } else if (c === '{' || c === '}') {
        if (c === '{') out += convert(readRaw(), mathMode);
        else i++;
      } else if (c === '^' || c === '_') {
        i++;
        out += script(readArg(), c === '^' ? SUPER : SUB, c);
      } else if (c === '\\') {
        const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i));
        if (!m) { i++; continue; }
        i += m[0].length;
        const name = m[1];
        if (TEXT_COMMANDS.has(name)) out += convert(readRaw(), false);
        else if (name === 'mathcal' || name === 'mathscr') out += script(readArg(), SCRIPT);
        else if (name === 'mathbb') out += script(readArg(), DOUBLE);
        else if (name in ACCENTS) out += readArg() + ACCENTS[name];
        else if (name === 'frac' || name === 'tfrac' || name === 'dfrac') {
          const a = readArg();
          const b = readArg();
          out += `${a}/${b}`;
        } else if (name === 'sqrt') {
          const a = readArg();
          out += [...a].length > 1 ? `√(${a})` : `√${a}`;
        } else if (IGNORED.has(name)) {
          /* 忽略 */
        } else if (name in SYMBOLS) out += SYMBOLS[name];
        else if (/^[,;:! ]$/.test(name)) out += mathMode ? '' : ' ';
        else if (name.length === 1) out += name; // \% \& \# \_ \{ \} \$
        else out += name;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  return function latexToUnicode(title) {
    if (!title || !title.includes('$')) return title;
    let out = '';
    let rest = title;
    for (;;) {
      const m = /(?<!\\)\$([^$]+?)(?<!\\)\$/.exec(rest);
      if (!m) break;
      const math = convert(m[1], true);
      out += rest.slice(0, m.index) + math;
      rest = rest.slice(m.index + m[0].length);
      // 有的数据在公式后面又附了一遍纯文本（如 $\ell _{0}$ℓ0），去掉重复
      const plain = [...math].map((ch) => PLAIN.get(ch) || ch).join('');
      if (plain && plain !== math && rest.startsWith(plain)) rest = rest.slice(plain.length);
      else if (rest.startsWith(math)) rest = rest.slice(math.length);
    }
    return (out + rest).replace(/\s{2,}/g, ' ').trim().normalize('NFC');
  };
})();

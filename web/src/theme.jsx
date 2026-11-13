import { useEffect, useState } from "react";

// Light is the default. Dark is a choice the visitor makes, kept in this browser.
const read = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function useTheme() {
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(read()));
    watch.observe(document.documentElement, { attributeFilter: ["data-theme"], attributes: true });
    return () => watch.disconnect();
  }, []);
  return theme;
}

// A theme colour as [r, g, b], read from the CSS tokens so canvases match the page.
export const tokenRgb = (name) => {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim().slice(1);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
};

export function ThemeSwitch({ className = "" }) {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  const flip = () => {
    if (next === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("allot-theme", next);
    } catch {
      // private mode or storage off: the choice lasts for this page only
    }
  };
  return (
    <button aria-label={`Switch to ${next} mode`} className={className} onClick={flip} type="button">
      {next === "dark" ? "Dark" : "Light"}
    </button>
  );
}

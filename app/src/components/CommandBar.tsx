import { useEffect, useMemo, useRef, useState } from "react";

export type Command = {
  id: string;
  glyph: string;
  label: string;
  desc: string;
  keywords?: string;
  run: () => void;
  disabled?: boolean;
};

export function CommandBar({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const usable = commands.filter((c) => !c.disabled);
    if (!needle) return usable;
    return usable.filter((c) =>
      `${c.label} ${c.desc} ${c.keywords ?? ""}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(matches.length - 1, 0)));
  }, [matches.length]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") return onClose();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => (c + 1) % Math.max(matches.length, 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => (c - 1 + matches.length) % Math.max(matches.length, 1));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = matches[cursor];
      if (chosen) {
        onClose();
        chosen.run();
      }
    }
  };

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="cmd" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd__input"
          placeholder="What should the hound do?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="cmd__list">
          {matches.length === 0 && (
            <div className="cmd__item">
              <span className="cmd__glyph">∅</span>
              <span className="cmd__label">Nothing matches “{query}”</span>
            </div>
          )}
          {matches.map((command, index) => (
            <button
              key={command.id}
              className="cmd__item"
              data-sel={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => {
                onClose();
                command.run();
              }}
            >
              <span className="cmd__glyph">{command.glyph}</span>
              <span>
                <span className="cmd__label">{command.label}</span>
                <span className="cmd__desc">{command.desc}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="cmd__foot">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

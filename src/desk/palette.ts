/** Command palette: one fuzzy list for songs, references, genres, presets and every action (idiom's SiteSearch pattern). */
import { h } from "./dom.ts";
import { search } from "./search.ts";
import type { SearchEntry } from "./search.ts";

export interface Command extends SearchEntry {
  run: () => void;
  /** Shortcut shown on the right, if the command has one. */
  key?: string;
  /** The current choice in its group (the playing song, the loaded reference…). */
  current?: boolean;
}

export class Palette {
  readonly el: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private readonly empty: HTMLElement;
  private commands: Command[] = [];
  private shown: Command[] = [];
  private active = 0;

  constructor() {
    this.input = h("input");
    this.input.type = "text";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-expanded", "true");
    this.input.setAttribute("aria-controls", "palette-list");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-label", "Search songs and commands");
    this.list = h("ul", "palette-list");
    this.list.id = "palette-list";
    this.list.setAttribute("role", "listbox");
    this.empty = h("p", "palette-empty", "No matches.");
    const foot = h("p", "palette-foot", h("kbd", "", "↑↓"), " move ", h("kbd", "", "↵"), " run ", h("kbd", "", "esc"), " close");
    this.el = h("dialog", "palette", h("div", "palette-field", this.input), this.list, this.empty, foot);
    this.el.setAttribute("aria-label", "Command palette");
    this.el.addEventListener("click", (ev) => {
      if (ev.target === this.el) this.el.close();
    });
    this.input.addEventListener("input", () => this.filter());
    this.input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || (ev.key === "n" && ev.ctrlKey)) this.highlight(this.active + 1);
      else if (ev.key === "ArrowUp" || (ev.key === "p" && ev.ctrlKey)) this.highlight(this.active - 1);
      else if (ev.key === "Enter") this.choose(this.shown[this.active]);
      else return;
      ev.preventDefault();
    });
    // Keys typed here must not also drive the desk underneath.
    this.el.addEventListener("keydown", (ev) => ev.stopPropagation());
  }

  get open(): boolean {
    return this.el.open;
  }

  show(commands: Command[], query = "", placeholder = "Type a song, a setting or a command"): void {
    this.commands = commands;
    this.input.value = query;
    this.input.placeholder = placeholder;
    this.filter();
    if (!this.el.open) this.el.showModal();
    this.input.focus();
    this.input.select();
  }

  private filter(): void {
    this.shown = search(this.commands, this.input.value);
    let group = "";
    const rows: HTMLElement[] = [];
    this.shown.forEach((c, i) => {
      if (c.group !== group) {
        group = c.group;
        rows.push(h("li", "palette-group", group));
      }
      const li = h("li", `palette-item${c.current ? " current" : ""}`, h("span", "palette-title", c.title), ...(c.key ? [h("kbd", "", c.key)] : []));
      li.id = `palette-${i}`;
      li.setAttribute("role", "option");
      li.onclick = (): void => this.choose(c);
      li.onpointermove = (): void => {
        if (this.active !== i) this.highlight(i);
      };
      rows.push(li);
    });
    this.list.replaceChildren(...rows);
    this.empty.hidden = this.shown.length > 0;
    const current = this.input.value.trim() ? -1 : this.shown.findIndex((c) => c.current);
    this.highlight(Math.max(0, current));
  }

  private highlight(index: number): void {
    const n = this.shown.length;
    this.active = n ? ((index % n) + n) % n : 0;
    for (const li of this.list.querySelectorAll("[role=option]")) li.setAttribute("aria-selected", String(li.id === `palette-${this.active}`));
    const li = this.list.querySelector<HTMLElement>(`#palette-${this.active}`);
    if (li) {
      this.input.setAttribute("aria-activedescendant", li.id);
      li.scrollIntoView({ block: "nearest" });
    } else this.input.removeAttribute("aria-activedescendant");
  }

  private choose(c: Command | undefined): void {
    if (!c) return;
    this.el.close();
    c.run();
  }
}

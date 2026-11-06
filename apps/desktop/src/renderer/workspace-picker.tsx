import { useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, Plus, Search } from "lucide-react";
import type { Project } from "@ruukoto/core/types.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu.tsx";
import { Input } from "./components/ui/input.tsx";

export function filterWorkspaces(workspaces: Project[], query: string): Project[] {
  const needle = query.trim().toLocaleLowerCase();
  return workspaces.filter(project => !project.managed && (!needle || project.name.toLocaleLowerCase().includes(needle)));
}
export function WorkspacePicker({ workspaces, value, disabled = false, allowManaged = false, onChange, onAdd }: { workspaces: Project[]; value: string; disabled?: boolean; allowManaged?: boolean; onChange: (id: string) => void; onAdd?: () => void }) {
  const search = useRef<HTMLInputElement>(null), [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const selected = workspaces.find(project => project.id === value && project.rootDir !== null && !project.managed), matches = filterWorkspaces(workspaces, query);
  // The search field owns typeahead while the menu is open.
  useEffect(() => { if (open) window.requestAnimationFrame(() => search.current?.focus()); }, [open]);
  function choose(id: string) { onChange(id); setOpen(false); }
  return <DropdownMenu open={open} onOpenChange={next => { setOpen(next); if (!next) setQuery(""); }}><DropdownMenuTrigger asChild><button type="button" disabled={disabled} className="workspace-picker" aria-label="选择工作区" aria-description={selected?.name} aria-expanded={open}><Folder /><span className={selected ? "" : "is-empty"}>{selected?.name ?? (allowManaged ? "No workspace" : "选择工作区")}</span><ChevronDown className="workspace-picker-chevron" /></button></DropdownMenuTrigger><DropdownMenuContent className="composer-menu workspace-menu" side="top" align="start" sideOffset={6} aria-label="工作区">
    <div className="workspace-menu-search"><Search aria-hidden="true" /><Input ref={search} aria-label="搜索工作区" placeholder="搜索工作区" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter" && matches[0]) { event.preventDefault(); choose(matches[0].id); } }} /></div><DropdownMenuSeparator />
    <DropdownMenuGroup className="workspace-menu-list">{allowManaged && !query && <DropdownMenuItem onSelect={() => choose("")}><Folder /><span>No workspace</span></DropdownMenuItem>}{matches.map(project => <DropdownMenuItem key={project.id} onSelect={() => choose(project.id)}><Folder /><span>{project.name}</span></DropdownMenuItem>)}{!matches.length && (!allowManaged || !!query) && <p className="workspace-menu-empty">{workspaces.length ? "没有匹配的工作区" : "还没有工作区"}</p>}</DropdownMenuGroup>
    {onAdd && <><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuItem onSelect={onAdd}><Plus /><span>新建工作区</span></DropdownMenuItem></DropdownMenuGroup></>}
  </DropdownMenuContent></DropdownMenu>;
}

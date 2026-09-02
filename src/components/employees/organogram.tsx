import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, User } from "lucide-react";
import type { Employee } from "@/lib/mock-data";
import { coreApi } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type Node = { name: string; role: string; current?: boolean; children?: Node[] };

type OrgTreeNode = {
  id: string;
  name: string;
  designation?: string;
  cadre?: string;
  department?: string;
  directReports?: OrgTreeNode[];
};

function toNode(t: OrgTreeNode, currentId?: string): Node {
  return {
    name: t.name,
    role: [t.designation, t.cadre].filter(Boolean).join(" · "),
    current: currentId ? t.id === currentId : false,
    children: t.directReports?.map((c) => toNode(c, currentId)),
  };
}

export function Organogram({ employee }: { employee: Employee }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["employee-org-tree", employee.id],
    queryFn: () => coreApi.getEmployeeOrgTree(employee.id),
    enabled: !!employee.id,
  });

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading organogram…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6 text-center text-xs text-muted-foreground">
        Reporting structure unavailable.
      </div>
    );
  }

  const managerChain: { id: string; name: string; designation: string; cadre: string }[] =
    data.managerChain || [];
  const tree: OrgTreeNode | undefined = data.tree;

  if (!tree) {
    return (
      <div className="p-6 text-center text-xs text-muted-foreground">
        No reporting structure found.
      </div>
    );
  }

  // Build root -> ... -> employee (with subtree) using managerChain (top-most first) + tree
  let root: Node = toNode(tree, employee.id);
  for (let i = managerChain.length - 1; i >= 0; i--) {
    const m = managerChain[i];
    root = {
      name: m.name,
      role: [m.designation, m.cadre].filter(Boolean).join(" · "),
      children: [root],
    };
  }

  return (
    <div className="text-sm">
      <TreeNode node={root} depth={0} />
    </div>
  );
}

/** Renders one or more raw org-tree nodes (as returned by the department org-tree endpoint). */
export function OrgTreeList({ trees }: { trees: OrgTreeNode[] }) {
  if (!trees.length) {
    return (
      <div className="p-6 text-center text-xs text-muted-foreground">
        No reporting structure found for this department.
      </div>
    );
  }
  return (
    <div className="text-sm space-y-2">
      {trees.map((t) => (
        <TreeNode key={t.id} node={toNode(t)} depth={0} />
      ))}
    </div>
  );
}

function TreeNode({ node, depth }: { node: Node; depth: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = !!node.children?.length;
  return (
    <div>
      <button
        onClick={() => hasChildren && setOpen((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-surface-muted",
          node.current && "bg-primary-soft border border-primary/30",
        )}
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        {hasChildren ? (
          open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />
        ) : (
          <span className="size-3.5" />
        )}
        <div className="size-6 rounded-full bg-surface-muted text-primary grid place-items-center shrink-0">
          <User className="size-3" />
        </div>
        <div className="leading-tight min-w-0">
          <div className={cn("text-xs font-medium truncate", node.current && "text-primary")}>{node.name}</div>
          <div className="text-[10px] text-muted-foreground truncate">{node.role}</div>
        </div>
      </button>
      {hasChildren && open && (
        <div className="border-l border-dashed border-border ml-[18px]">
          {node.children!.map((c, i) => (
            <TreeNode key={i} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

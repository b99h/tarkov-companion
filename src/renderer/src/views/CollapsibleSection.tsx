import type { ReactNode } from 'react'

/**
 * A titled section with a caret toggle, shared by the Flea and Hideout views.
 * Collapse state is owned by the caller (usually persisted).
 */
export function CollapsibleSection({
  title,
  count,
  collapsed,
  onToggle,
  children
}: {
  title: string
  count?: number
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="collapsible-section">
      <h2 className="group-header" onClick={onToggle}>
        <span className={`caret${collapsed ? ' collapsed' : ''}`}>▾</span>
        {title}
        {count !== undefined && <span className="group-count">{count}</span>}
      </h2>
      {!collapsed && children}
    </section>
  )
}

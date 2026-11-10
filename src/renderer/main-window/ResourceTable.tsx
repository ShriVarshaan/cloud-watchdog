// Every resource of the latest scan, sortable and filterable. A row is
// chosen with its first-cell button (Tab, Enter or a click); the arrow keys
// move between rows.

import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { KIND_EXPLANATIONS } from '../../shared/explain'
import { RESOURCE_KINDS, type Flag, type PricedResource, type ResourceKind, type Severity } from '../../shared/types'
import { CoverageBadge, PriceBadge, SeverityMark } from '../components/Badges'

type SortKey = 'name' | 'region' | 'state' | 'cost' | 'coverage' | 'warnings'
type Sort = { key: SortKey; descending: boolean }

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warn: 2, info: 1 }

export interface Row {
  resource: PricedResource
  flags: Flag[]
  /** The most severe visible flag, or null. */
  worst: Severity | null
}

export function buildRows(resources: readonly PricedResource[], visibleFlags: readonly Flag[]): Row[] {
  return resources.map((resource) => {
    const flags = visibleFlags.filter((flag) => flag.resourceKey === resource.key)
    const worst = flags.reduce<Severity | null>(
      (most, flag) => (most === null || SEVERITY_RANK[flag.severity] > SEVERITY_RANK[most] ? flag.severity : most),
      null
    )
    return { resource, flags, worst }
  })
}

const label = (resource: PricedResource) => resource.name ?? resource.id

function compare(a: Row, b: Row, key: SortKey): number {
  switch (key) {
    case 'name':
      return label(a.resource).localeCompare(label(b.resource))
    case 'region':
      return a.resource.region.localeCompare(b.resource.region)
    case 'state':
      return a.resource.state.localeCompare(b.resource.state)
    case 'cost':
      // Unpriced last whichever way: an unknown is not cheap, and not expensive either.
      return (a.resource.price.hourlyUsd ?? -1) - (b.resource.price.hourlyUsd ?? -1)
    case 'coverage':
      return a.resource.coverage.localeCompare(b.resource.coverage)
    case 'warnings':
      return (a.worst ? SEVERITY_RANK[a.worst] : 0) - (b.worst ? SEVERITY_RANK[b.worst] : 0) || a.flags.length - b.flags.length
  }
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Resource' },
  { key: 'region', label: 'Region' },
  { key: 'state', label: 'State' },
  { key: 'cost', label: 'Cost' },
  { key: 'coverage', label: 'Paid by' },
  { key: 'warnings', label: 'Warnings' }
]

export function ResourceTable({
  rows,
  selectedKey,
  onSelect
}: {
  rows: readonly Row[]
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  const [sort, setSort] = useState<Sort>({ key: 'cost', descending: true })
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<ResourceKind | 'all'>('all')
  const [warningsOnly, setWarningsOnly] = useState(false)
  const body = useRef<HTMLTableSectionElement>(null)

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const filtered = rows.filter(
      ({ resource, flags }) =>
        (kind === 'all' || resource.kind === kind) &&
        (!warningsOnly || flags.length > 0) &&
        (!needle || [resource.id, resource.name ?? '', resource.region, resource.state].some((v) => v.toLowerCase().includes(needle)))
    )
    const sorted = [...filtered].sort((a, b) => {
      if (sort.key === 'cost') {
        // Unpriced always last.
        const unknownA = a.resource.price.hourlyUsd === null
        const unknownB = b.resource.price.hourlyUsd === null
        if (unknownA !== unknownB) return unknownA ? 1 : -1
      }
      const order = compare(a, b, sort.key)
      return (sort.descending ? -order : order) || a.resource.key.localeCompare(b.resource.key)
    })
    return sorted
  }, [rows, search, kind, warningsOnly, sort])

  function sortBy(key: SortKey) {
    setSort((current) => (current.key === key ? { key, descending: !current.descending } : { key, descending: key === 'cost' || key === 'warnings' }))
  }

  /** Up and down move to the next row's button and choose it. */
  function onRowKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const next = shown[index + (event.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    onSelect(next.resource.key)
    body.current?.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(next.resource.key)}"]`)?.focus()
  }

  return (
    <section className="resources" aria-labelledby="resources-title">
      <h2 id="resources-title" className="visually-hidden">
        Resources
      </h2>
      <div className="filters">
        <label>
          <span className="visually-hidden">Search resources</span>
          <input type="search" placeholder="Search by name, id, region or state" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label>
          <span className="visually-hidden">Kind of resource</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as ResourceKind | 'all')}>
            <option value="all">Every kind</option>
            {RESOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_EXPLANATIONS[k].name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={warningsOnly} onChange={(e) => setWarningsOnly(e.target.checked)} />
          Only with warnings
        </label>
      </div>

      <table>
        <caption className="visually-hidden">
          {shown.length} of {rows.length} resources. Use the column buttons to sort.
        </caption>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                scope="col"
                aria-sort={sort.key === column.key ? (sort.descending ? 'descending' : 'ascending') : undefined}
                className={column.key === 'cost' ? 'numeric' : undefined}
              >
                <button type="button" className="sort" onClick={() => sortBy(column.key)}>
                  {column.label}
                  <span aria-hidden="true" className="sort-arrow">
                    {sort.key === column.key ? (sort.descending ? '↓' : '↑') : ''}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={body}>
          {shown.map(({ resource, flags, worst }, index) => (
            <tr key={resource.key} aria-selected={resource.key === selectedKey} data-stale={resource.stale || undefined}>
              <th scope="row">
                <button
                  type="button"
                  className="row-button"
                  data-key={resource.key}
                  onClick={() => onSelect(resource.key)}
                  onKeyDown={(event) => onRowKey(event, index)}
                >
                  <span className="row-name">{label(resource)}</span>
                  <span className="row-kind">
                    {KIND_EXPLANATIONS[resource.kind].name}
                    {resource.name ? `, ${resource.id}` : ''}
                  </span>
                </button>
              </th>
              <td>{resource.region}</td>
              <td>
                {resource.state}
                {resource.stale && <span className="stale"> (old data)</span>}
              </td>
              <td className="numeric">
                <PriceBadge price={resource.price} compact />
              </td>
              <td>
                <CoverageBadge coverage={resource.coverage} />
              </td>
              <td>{worst ? <><SeverityMark severity={worst} />{flags.length > 1 && <span className="quiet"> +{flags.length - 1}</span>}</> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && (
        <p className="empty">{rows.length === 0 ? 'No resources found in any enabled region. Nothing is costing money.' : 'No resources match these filters.'}</p>
      )}
    </section>
  )
}

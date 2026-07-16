import { useMemo } from 'react'
import { getKappaProgress, scoreNextTargets, itemsToHoard } from '@shared/questEngine'
import { useAppData } from '../state/AppDataContext'

export function KappaPlanner(): React.JSX.Element {
  const { tasks, progress, loading, error } = useAppData()

  const kappaProgress = useMemo(
    () => (tasks && progress ? getKappaProgress(tasks, progress) : null),
    [tasks, progress]
  )
  const nextTargets = useMemo(
    () => (tasks && progress ? scoreNextTargets(tasks, progress) : []),
    [tasks, progress]
  )
  const hoard = useMemo(
    () => (tasks && progress ? itemsToHoard(tasks, progress).slice(0, 15) : []),
    [tasks, progress]
  )

  if (loading) return <p>Loading Kappa data…</p>
  if (error) return <p className="error">Failed to load quest data: {error}</p>
  if (!kappaProgress) return <p>No data.</p>

  return (
    <div className="kappa-planner">
      <section className="kappa-progress">
        <h2>Kappa progress</h2>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${kappaProgress.percent}%` }} />
        </div>
        <p>
          {kappaProgress.completed} / {kappaProgress.total} Kappa quests completed (
          {kappaProgress.percent}%)
        </p>
      </section>

      <section className="next-targets">
        <h2>Recommended next targets</h2>
        {nextTargets.length === 0 ? (
          <p>Nothing available right now — check locked quests on the Quest Board.</p>
        ) : (
          <ol>
            {nextTargets.map(({ task, reasons }) => (
              <li key={task.id}>
                <span className="quest-name">
                  {task.kappaRequired && <span className="kappa-star">★</span>}
                  {task.name}
                </span>
                <span className="quest-trader">{task.trader}</span>
                <span className="reasons">{reasons.join(' · ')}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="hoard-list">
        <h2>Items to hoard</h2>
        <p className="hint">Found-in-raid items needed for quests you haven't completed yet.</p>
        {hoard.length === 0 ? (
          <p>Nothing to hoard right now.</p>
        ) : (
          <ul>
            {hoard.map((item) => (
              <li key={item.itemName}>
                <span className="item-name">{item.itemName}</span>
                <span className="item-count">×{item.totalCount}</span>
                <span className="needed-for">
                  {item.neededFor.slice(0, 3).join(', ')}
                  {item.neededFor.length > 3 ? ` +${item.neededFor.length - 3} more` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

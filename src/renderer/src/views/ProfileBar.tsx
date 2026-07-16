import { useAppData } from '../state/AppDataContext'
import type { Faction } from '@shared/types'

export function ProfileBar(): React.JSX.Element | null {
  const { progress, updatePlayerLevel, updateFaction, reset } = useAppData()

  if (!progress) return null

  return (
    <div className="profile-bar">
      <label>
        Level
        <input
          type="number"
          min={1}
          max={79}
          value={progress.playerLevel}
          onChange={(e) => updatePlayerLevel(Number(e.target.value) || 1)}
        />
      </label>
      <label>
        Faction
        <select
          value={progress.faction}
          onChange={(e) => updateFaction(e.target.value as Faction)}
        >
          <option value="Usec">USEC</option>
          <option value="Bear">BEAR</option>
        </select>
      </label>
      <button
        className="reset-button"
        onClick={() => {
          if (confirm('Reset all quest progress? This cannot be undone.')) reset()
        }}
      >
        Reset progress (wipe)
      </button>
    </div>
  )
}

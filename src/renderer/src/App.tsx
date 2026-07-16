import { useEffect, useState } from 'react'
import { AppDataProvider } from './state/AppDataContext'
import { QuestBoard } from './views/QuestBoard'
import { KappaPlanner } from './views/KappaPlanner'
import { FleaSidebar } from './views/FleaSidebar'
import { Hideout } from './views/Hideout'
import { AmmoChart } from './views/AmmoChart'
import { MapView } from './views/MapView'
import { ProfileBar } from './views/ProfileBar'
import { Settings } from './views/Settings'
import { QuestCatchup } from './views/QuestCatchup'
import { Toasts } from './views/Toasts'
import { UpdateBanner } from './views/UpdateBanner'
import { ErrorBoundary } from './views/ErrorBoundary'

type View = 'quests' | 'kappa' | 'flea' | 'hideout' | 'ammo' | 'maps' | 'settings' | 'catchup'

function App(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [view, setView] = useState<View>('quests')

  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
  }, [])

  return (
    <AppDataProvider>
      <div className="app-shell">
        <header>
          <h1>Tarkov Companion</h1>
          <span className="version">v{version}</span>
        </header>
        <UpdateBanner />
        <nav>
          <button className={view === 'quests' ? 'active' : ''} onClick={() => setView('quests')}>
            Quest Board
          </button>
          <button className={view === 'kappa' ? 'active' : ''} onClick={() => setView('kappa')}>
            Kappa Planner
          </button>
          <button className={view === 'flea' ? 'active' : ''} onClick={() => setView('flea')}>
            Flea &amp; Crafts
          </button>
          <button
            className={view === 'hideout' ? 'active' : ''}
            onClick={() => setView('hideout')}
          >
            Hideout
          </button>
          <button className={view === 'ammo' ? 'active' : ''} onClick={() => setView('ammo')}>
            Ammo
          </button>
          <button className={view === 'maps' ? 'active' : ''} onClick={() => setView('maps')}>
            Maps
          </button>
          <button
            className={view === 'settings' ? 'active' : ''}
            onClick={() => setView('settings')}
          >
            Log Watcher
          </button>
          <button
            className={view === 'catchup' ? 'active' : ''}
            onClick={() => setView('catchup')}
          >
            Quest Catchup
          </button>
        </nav>
        <ProfileBar />
        <main>
          {/* Keyed by view so a caught error clears when you switch views, and
              one broken view degrades to an error card instead of a blank app. */}
          <ErrorBoundary key={view}>
            {view === 'quests' && <QuestBoard />}
            {view === 'kappa' && <KappaPlanner />}
            {view === 'flea' && <FleaSidebar />}
            {view === 'hideout' && <Hideout />}
            {view === 'ammo' && <AmmoChart />}
            {view === 'maps' && <MapView />}
            {view === 'settings' && <Settings />}
            {view === 'catchup' && <QuestCatchup />}
          </ErrorBoundary>
        </main>
        <Toasts />
      </div>
    </AppDataProvider>
  )
}

export default App

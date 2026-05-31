import { QueryInput } from '../../components/query-input'
import { Vibes } from '../../components/vibes'
import { Sidebar } from '../sidebar'

import './app-layout.sass'

export function AppLayout() {
  return (
    <div className="app-layout">
      <Vibes />
      <Sidebar />
      <main>
        <QueryInput />
      </main>
    </div>
  )
}

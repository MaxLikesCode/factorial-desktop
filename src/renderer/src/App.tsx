import { Toaster } from '@renderer/components/ui/sonner'
import { StatusWidget } from '@renderer/components/StatusWidget'

export default function App(): React.JSX.Element {
  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent">
      <StatusWidget />
      {/*
        Bottom-centre and rich colours off: the window is 340×224 and frameless,
        so a toast in a corner would sit half outside the rounded card.
      */}
      <Toaster position="bottom-center" />
    </div>
  )
}

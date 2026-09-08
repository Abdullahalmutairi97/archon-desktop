import { fireEvent, render, screen } from '@testing-library/react'
import { TitleBar } from './TitleBar'

it('renders the 36px icon-only bench and separate sidebar/window controls', () => {
  const onBench = vi.fn()
  const onSidebar = vi.fn()
  const onRefresh = vi.fn()
  render(<TitleBar title="Chat · Archon" crumb="Chat" bench="files" unseen={{ tasks: true }} onBench={onBench} onSidebar={onSidebar} onRefresh={onRefresh}/>)

  fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
  fireEvent.click(screen.getByRole('button', { name: 'Activity' }))

  expect(onSidebar).toHaveBeenCalledOnce()
  expect(onBench).toHaveBeenCalledWith('tasks')
  expect(screen.getByText('Chat')).toBeInTheDocument()
  expect(screen.queryByText('Activity')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Files' })).toHaveClass('active')
  expect(screen.getByRole('button', { name: 'Activity' }).querySelector('i')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
})
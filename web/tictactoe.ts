// Classic tic-tac-toe, played only by clicking the board.
// Deliberately self-contained: nothing is exported, nothing is put on `window`, and
// it isn't part of the WIT `page` interface, so the Hono server can't touch it.

type Player = 'X' | 'O'
type Cell = Player | null

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
]

function winnerOf(board: Cell[]) {
  for (const line of LINES) {
    const [a, b, c] = line
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { player: board[a]!, line }
  }
  return null
}

function mount(root: HTMLElement) {
  const boardEl = root.querySelector<HTMLDivElement>('.ttt-board')!
  const statusEl = root.querySelector<HTMLParagraphElement>('.ttt-status')!
  const resetBtn = root.querySelector<HTMLButtonElement>('.ttt-reset')!

  let board: Cell[] = Array(9).fill(null)
  let turn: Player = 'X'
  let over = false

  const cells = Array.from({ length: 9 }, (_, i) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ttt-cell'
    btn.addEventListener('click', () => play(i))
    boardEl.append(btn)
    return btn
  })

  function play(i: number) {
    if (over || board[i]) return
    board[i] = turn
    turn = turn === 'X' ? 'O' : 'X'
    render()
  }

  function render() {
    const win = winnerOf(board)
    const full = board.every(Boolean)
    over = Boolean(win) || full

    cells.forEach((btn, i) => {
      const row = Math.floor(i / 3) + 1
      const col = (i % 3) + 1
      btn.textContent = board[i] ?? ''
      btn.dataset.mark = board[i] ?? ''
      btn.classList.toggle('ttt-win', Boolean(win?.line.includes(i)))
      btn.disabled = over || Boolean(board[i])
      btn.setAttribute('aria-label', `Row ${row}, column ${col}: ${board[i] ?? 'empty'}`)
    })

    statusEl.textContent = win ? `${win.player} wins!` : full ? "It's a draw." : `${turn} to move`
    statusEl.classList.toggle('ttt-over', over)
  }

  resetBtn.addEventListener('click', () => {
    board = Array(9).fill(null)
    turn = 'X'
    render()
  })

  render()
}

const root = document.getElementById('tictactoe')
if (root) mount(root)

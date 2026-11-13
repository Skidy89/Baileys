declare global {
	interface RequestInit {
		dispatcher?: import('https').Agent
		duplex?: 'half' | 'full'
	}
}

export {}

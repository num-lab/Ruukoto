import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
export default { plugins: [react(), tailwind()], server: { host: '127.0.0.1', port: 4318, strictPort: true }, appType: 'spa' };

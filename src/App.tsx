import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Index from './pages/Index';
import NotFound from './pages/NotFound';

/**
 * App shell.
 *
 * Previously wrapped the game in a toast provider, a second toast provider, a
 * tooltip provider and a react-query client — none of which the game ever
 * used. It renders to a canvas and styles itself with plain CSS.
 */
const App = () => (
  // Derived from Vite's base so the dev server (served at /) and the GitHub
  // Pages build (served at /mathfallx/) both route correctly. A hardcoded
  // basename made every dev route fall through to NotFound.
  <BrowserRouter basename={import.meta.env.BASE_URL}>
    <Routes>
      <Route path="/" element={<Index />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </BrowserRouter>
);

export default App;

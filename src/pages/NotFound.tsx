import { Link, useLocation } from 'react-router-dom';
import { useEffect } from 'react';

/** Plain CSS — this page was the last thing in the app using Tailwind. */
const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error('404: no route for', location.pathname);
  }, [location.pathname]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        textAlign: 'center',
        padding: 24,
      }}
    >
      <div>
        <h1 style={{ fontSize: 64, fontWeight: 900, margin: 0, letterSpacing: '-0.03em' }}>404</h1>
        <p style={{ color: 'rgba(234,230,255,0.6)', margin: '8px 0 20px' }}>
          Nothing here.
        </p>
        <Link
          to="/"
          style={{
            display: 'inline-block',
            padding: '12px 22px',
            borderRadius: 12,
            border: '1px solid rgba(255,45,149,0.6)',
            background: 'rgba(255,45,149,0.16)',
            color: '#fff',
            fontWeight: 800,
            textDecoration: 'none',
          }}
        >
          Back to MathFall
        </Link>
      </div>
    </div>
  );
};

export default NotFound;

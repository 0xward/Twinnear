import { Suspense, lazy, useEffect } from "react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import WalletButton from "./components/WalletButton";
import ScrollProgress from "./components/ScrollProgress";

// Route pages are lazy-loaded so the initial bundle stays small; the
// heavy NEAR libraries live in lib/near.ts behind dynamic import().
const Landing = lazy(() => import("./pages/Landing"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const About = lazy(() => import("./pages/About"));
const Docs = lazy(() => import("./pages/Docs"));
const Faq = lazy(() => import("./pages/Faq"));
const Privacy = lazy(() => import("./pages/Privacy"));
const Invoices = lazy(() => import("./pages/Invoices"));
const NewInvoice = lazy(() => import("./pages/NewInvoice"));
const PayInvoice = lazy(() => import("./pages/PayInvoice"));
const PublicInvoice = lazy(() => import("./pages/PublicInvoice"));
const PolicyPage = lazy(() => import("./pages/Policy"));
const Portal = lazy(() => import("./pages/Portal"));
const Recurring = lazy(() => import("./pages/Recurring"));

function PageFallback() {
  return (
    <div className="card">
      <p className="sub">Loading page…</p>
    </div>
  );
}

/** A new route starts at the top: without this, opening a page from
 * the bottom of a long one (the landing page) would land mid-page. */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  const { pathname } = useLocation();
  return (
    <div className="sheet">
      <ScrollProgress />
      <ScrollToTop />
      <header className="masthead">
        <Link className="brand" to="/">
          <img className="brand-mark" src="/logo.svg" alt="Twinnear" />
          <span>
            <small>Freelancer invoicing on NEAR</small>
          </span>
        </Link>
        <WalletButton />
      </header>

      <nav className="nav" aria-label="Main navigation">
        <NavLink to="/" end>
          Home
        </NavLink>
        <NavLink to="/ledger">Ledger</NavLink>
        <NavLink to="/invoices">Invoices</NavLink>
        <NavLink to="/invoices/new">New invoice</NavLink>
        <NavLink to="/recurring">Retainers</NavLink>
        <NavLink to="/portal">Client portal</NavLink>
        <NavLink to="/spend-guard">Spend guard</NavLink>
      </nav>

      {/* Keyed by pathname so the page entrance plays on every
       * navigation, not just the first load. */}
      <div key={pathname} className="page-enter">
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/ledger" element={<Dashboard />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/new" element={<NewInvoice />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/portal" element={<Portal />} />
          <Route path="/pay/:id" element={<PayInvoice />} />
          <Route path="/invoice/:id" element={<PublicInvoice />} />
          <Route path="/spend-guard" element={<PolicyPage />} />
          {/* Old URL: keep bookmarks and older links working. */}
          <Route
            path="/settings"
            element={<Navigate to="/spend-guard" replace />}
          />
          <Route path="/about" element={<About />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/faq" element={<Faq />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route
            path="*"
            element={
              <div className="card">
                <h2>Page not found</h2>
                <p className="sub">
                  <Link to="/ledger">Back to the ledger</Link>
                </p>
              </div>
            }
          />
        </Routes>
      </Suspense>
      </div>

      <footer className="footer">
        <nav className="footer-nav" aria-label="Learn more">
          <Link to="/about">About</Link>
          <Link to="/docs">Docs</Link>
          <Link to="/faq">FAQ</Link>
          <Link to="/privacy">Privacy</Link>
        </nav>
        <p className="footer-fine">
          Freelancer invoicing on NEAR. Testnet only. Contract
          twinnear.testnet · schema v4.{" "}
          <a
            href="https://github.com/0xward/Twinnear"
            target="_blank"
            rel="noreferrer"
          >
            0xward/Twinnear
          </a>
        </p>
      </footer>
    </div>
  );
}

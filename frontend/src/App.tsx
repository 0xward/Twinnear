import { Suspense, lazy } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import WalletButton from "./components/WalletButton";

// Route pages are lazy-loaded so the initial bundle stays small; the
// heavy NEAR libraries live in lib/near.ts behind dynamic import().
const Dashboard = lazy(() => import("./pages/Dashboard"));
const About = lazy(() => import("./pages/About"));
const Docs = lazy(() => import("./pages/Docs"));
const Faq = lazy(() => import("./pages/Faq"));
const Invoices = lazy(() => import("./pages/Invoices"));
const NewInvoice = lazy(() => import("./pages/NewInvoice"));
const PayInvoice = lazy(() => import("./pages/PayInvoice"));
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

export default function App() {
  return (
    <div className="sheet">
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
          Ledger
        </NavLink>
        <NavLink to="/invoices">Invoices</NavLink>
        <NavLink to="/invoices/new">New invoice</NavLink>
        <NavLink to="/recurring">Retainers</NavLink>
        <NavLink to="/portal">Client portal</NavLink>
        <NavLink to="/settings">Spend guard</NavLink>
        <NavLink to="/about">About</NavLink>
        <NavLink to="/docs">Docs</NavLink>
        <NavLink to="/faq">FAQ</NavLink>
      </nav>

      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/new" element={<NewInvoice />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/portal" element={<Portal />} />
          <Route path="/pay/:id" element={<PayInvoice />} />
          <Route path="/settings" element={<PolicyPage />} />
          <Route path="/about" element={<About />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/faq" element={<Faq />} />
          <Route
            path="*"
            element={
              <div className="card">
                <h2>Page not found</h2>
                <p className="sub">
                  <Link to="/">Back to the ledger</Link>
                </p>
              </div>
            }
          />
        </Routes>
      </Suspense>

      <footer className="footer">
        Twinnear is a port of TwinPayAI (Stacks) to NEAR. Only the NEAR
        integration is new. Testnet only. Contract twinnear.testnet ·
        schema v2.{" "}
        <Link to="/about">About</Link> · <Link to="/docs">Docs</Link> ·{" "}
        <Link to="/faq">FAQ</Link> · <Link to="/">Ledger</Link> ·{" "}
        <a
          href="https://github.com/0xward/Twinnear"
          target="_blank"
          rel="noreferrer"
        >
          0xward/Twinnear
        </a>
      </footer>
    </div>
  );
}

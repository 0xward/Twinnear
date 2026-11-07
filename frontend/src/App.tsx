import { Suspense, lazy, useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import WalletButton from "./components/WalletButton";
import { isContractDeployed } from "./lib/near";
import { CONTRACT_ID } from "./lib/config";

// Route pages are lazy-loaded so the initial bundle stays small; the
// heavy NEAR libraries live in lib/near.ts behind dynamic import().
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Deploy = lazy(() => import("./pages/Deploy"));
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
  const [deployed, setDeployed] = useState<boolean | null>(null);

  useEffect(() => {
    isContractDeployed()
      .then(setDeployed)
      .catch(() => setDeployed(false));
  }, []);

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
        <NavLink to="/deploy">Deploy</NavLink>
      </nav>

      {deployed === false && (
        <div className="notice" aria-live="polite">
          <strong>Contract not deployed yet.</strong> The Twinnear contract (
          <code>{CONTRACT_ID}</code>) is not deployed on testnet yet. Follow README “Deploy the contract” first. The pages below will work once
          it is deployed.
        </div>
      )}

      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/new" element={<NewInvoice />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/portal" element={<Portal />} />
          <Route path="/pay/:id" element={<PayInvoice />} />
          <Route path="/settings" element={<PolicyPage />} />
          <Route path="/deploy" element={<Deploy />} />
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
        integration is new. Testnet only.{" "}
        <Link to="/">Ledger</Link> ·{" "}
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

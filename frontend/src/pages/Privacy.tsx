import { Link } from "react-router-dom";
import Reveal from "../components/Reveal";

export default function Privacy() {
  return (
    <div>
      <div className="page-head">
        <h1>Privacy</h1>
        <p className="muted">
          Twinnear collects almost nothing. This page says exactly what
          the site sees, stores, and shares. Last updated 8 November
          2026.
        </p>
      </div>

      <Reveal>
        <div className="card">
          <h2>No accounts, no signup</h2>
          <p>
            There is no account to create, no email to give, and no
            password to remember. You connect a NEAR wallet to sign
            things, and the signing happens inside your wallet. The
            site never sees your private key, and it never asks for
            it.
          </p>
        </div>
      </Reveal>

      <Reveal>
        <div className="card">
          <h2>Your invoices are public</h2>
          <p>
            Invoices live on the NEAR testnet blockchain, in the
            contract twinnear.testnet. Anyone can read them in the
            explorer: the seller, the client, the amounts, the
            descriptions, and the status. That is the point of a
            public ledger. This is testnet play money, so do not put
            real personal information in an invoice.
          </p>
        </div>
      </Reveal>

      <Reveal>
        <div className="card">
          <h2>What your browser keeps</h2>
          <p>
            The site stores three things in your browser&apos;s local
            storage, and nothing else:
          </p>
          <ul>
            <li>
              Your wallet connection, so you stay connected between
              visits.
            </li>
            <li>
              Your retainer templates, which are frontend-only and
              are never sent to a server.
            </li>
            <li>
              A five-minute cache of fiat prices, so the ledger does
              not call CoinGecko on every render.
            </li>
          </ul>
          <p>
            No cookies for tracking. No analytics. Nothing is sent to
            a Twinnear server except the gasless relay request
            described below.
          </p>
        </div>
      </Reveal>

      <Reveal>
        <div className="card">
          <h2>What the relayer sees</h2>
          <p>
            When you create an invoice without paying gas, your
            browser sends the signed meta-transaction to the relayer,
            a serverless function on this site. It verifies your
            NEP-413 signature and submits the invoice on-chain. It
            keeps no database: the request history and locks live
            only in the function&apos;s memory and disappear when the
            instance is recycled. Everything it sees becomes public
            on-chain anyway.
          </p>
        </div>
      </Reveal>

      <Reveal>
        <div className="card">
          <h2>Third parties</h2>
          <p>
            A few requests leave your browser to other services: the
            NEAR RPC (FastNear) serves chain data, 1Click handles
            quotes and payments from other chains, CoinGecko supplies
            fiat price estimates, and Vercel hosts the site. Each of
            them sees the request you make to it, and their own
            privacy policies apply.
          </p>
        </div>
      </Reveal>

      <Reveal>
        <div className="card">
          <h2>Testnet only</h2>
          <p>
            This is a hackathon demo on testnet. Nothing here is real
            money, and the contract has not been formally audited.
            Treat anything you type as public test data.
          </p>
          <p>
            Questions? Open an issue on{" "}
            <a
              href="https://github.com/0xward/Twinnear"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>{" "}
            or read the <Link to="/about">about page</Link>.
          </p>
        </div>
      </Reveal>
    </div>
  );
}

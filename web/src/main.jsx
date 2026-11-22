import { createRoot } from "react-dom/client";
import "./index.css";
import App, { Gallery } from "./App.jsx";
import Landing from "./Landing.jsx";
import MyBid from "./MyBid.jsx";
import { short } from "./sale.js";
import Sell from "./Sell.jsx";
import TxPage from "./TxPage.jsx";

// / is the landing, /sales the gallery of sales, /sales/<id> one sale, /sell the listing form, /tx/<hash> one
// transaction. The old /sale path shows the gallery.
const one = location.pathname.match(/^\/sales\/(\d+)/);
const tx = location.pathname.match(/^\/tx\/(0x[0-9a-fA-F]{64}|[0-9A-Fa-f]{64})$/);
const [page, title] = tx ? [<TxPage hash={tx[1]} />, `Transaction ${short(tx[1])}`]
  : one ? [<App saleId={Number(one[1])} />, `Sale ${one[1]}`]
  : location.pathname === "/my-bid" ? [<MyBid />, "My bid"]
  : location.pathname === "/sell" ? [<Sell />, "Sell"]
  : location.pathname.startsWith("/sale") ? [<Gallery />, "Sales"]
  : [<Landing />]; // the landing keeps index.html's title
if (title) document.title = `${title} · Allot`;
createRoot(document.getElementById("root")).render(page);

import { p as parser, f as flowDb } from "./flowDb-197ba095.js";
import { f as flowRendererV2, g as flowStyles } from "./styles-85771346.js";
import { u as setConfig } from "./mermaid-720ce8be.js";
import "./graph-3e8e7d02.js";
import "./index-e72016ca.js";
import "./layout-0b458aed.js";
import "./clone-ae291aa1.js";
import "./edges-a9a05e48.js";
import "./createText-1e2f46de.js";
import "./line-244a3d0a.js";
import "./array-b7dcf730.js";
import "./path-39bad7e2.js";
import "./channel-9d8553c0.js";
const diagram = {
  parser,
  db: flowDb,
  renderer: flowRendererV2,
  styles: flowStyles,
  init: (cnf) => {
    if (!cnf.flowchart) {
      cnf.flowchart = {};
    }
    cnf.flowchart.arrowMarkerAbsolute = cnf.arrowMarkerAbsolute;
    setConfig({ flowchart: { arrowMarkerAbsolute: cnf.arrowMarkerAbsolute } });
    flowRendererV2.setConf(cnf.flowchart);
    flowDb.clear();
    flowDb.setGen("gen-2");
  }
};
export {
  diagram
};

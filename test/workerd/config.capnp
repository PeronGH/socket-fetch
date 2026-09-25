using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "main", worker = .worker)],
);

const worker :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "dist/worker.js")],
  compatibilityDate = "2026-08-01",
);

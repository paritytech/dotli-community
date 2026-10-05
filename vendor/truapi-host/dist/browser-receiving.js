/** Use only in the trusted host page, never in a product iframe. */
export function createBrowserReceivingClient(options) {
    const { registration } = options;
    let closed = false;
    const executions = new Set();
    async function request(operation, value) {
        if (closed)
            throw new Error("receiving client closed");
        const worker = registration.active;
        if (!worker)
            throw new Error("receiving service worker unavailable");
        const channel = new MessageChannel();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error("receiving service worker stalled")), 45_000);
            function finish(error, result) {
                clearTimeout(timer);
                channel.port1.close();
                if (error)
                    reject(error);
                else
                    resolve(result);
            }
            channel.port1.onmessage = event => {
                const reply = event.data;
                if (!reply || typeof reply.ok !== "boolean") {
                    finish(new Error("invalid receiving worker reply"));
                    return;
                }
                finish(reply.ok ? undefined : new Error(String(reply.error)), reply.value);
            };
            channel.port1.onmessageerror = () => finish(new Error("receiving worker message failed"));
            try {
                worker.postMessage({ type: "truapi:receiving", operation, value }, [channel.port2]);
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    const onMessage = (message) => {
        if (closed || message.source !== registration.active || message.data?.type !== "truapi:receiving-host" || !message.ports[0])
            return;
        const port = message.ports[0];
        const { operation, authority, watches, event } = message.data;
        void Promise.resolve().then(() => operation === "consent" ? options.consent(authority, watches)
            : operation === "activate" ? options.activate(authority, event) : false)
            .then(value => port.postMessage(value === true), () => port.postMessage(false)).finally(() => port.close());
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    const onOnline = () => { void request("refresh").catch(() => { }); };
    window.addEventListener("online", onOnline);
    return {
        getAuthority: (productId) => request("getAuthority", productId),
        updateAuthority: (authority) => request("authority", structuredClone(authority)),
        setActiveAccount: (account, environment, genesis) => request("activeAccount", { account, environment, genesis }),
        async bindExecution(authority) {
            const snapshot = structuredClone(authority);
            let id = await request("bind", snapshot);
            executions.add(id);
            let disposed = false;
            let ready = false;
            async function execute(operation, value) {
                if (disposed || !executions.has(id))
                    throw new Error("receiving execution closed");
                try {
                    return await request(operation, { ...value, id });
                }
                catch (error) {
                    // A missing lease guarantees the command never reached core. Never retry an ambiguous timeout.
                    if (!(error instanceof Error) || error.message !== "receiving execution unavailable; bind again after worker restart" || !executions.has(id))
                        throw error;
                    executions.delete(id);
                    id = await request("bind", snapshot);
                    if (disposed || closed) {
                        void request("unbind", { id }).catch(() => { });
                        throw new Error("receiving execution closed");
                    }
                    executions.add(id);
                    if (ready && operation !== "ready")
                        await request("ready", { id });
                    return request(operation, { ...value, id });
                }
            }
            return {
                command: (action, payload) => execute("command", { action, payload }),
                ready: async () => { await execute("ready", {}); ready = true; },
                close: () => {
                    disposed = true;
                    if (!executions.delete(id))
                        return;
                    void request("unbind", { id }).catch(() => { });
                },
            };
        },
        /** Call directly from a user gesture; never from product startup. */
        async enableWebPush(vapidPublicKey) {
            if (!navigator.userActivation?.isActive)
                throw new Error("WebPush permission requires a user gesture");
            if (!("PushManager" in window) || !("Notification" in window))
                throw new Error("WebPush unavailable");
            const permission = await Notification.requestPermission();
            if (permission !== "granted") {
                await request("refresh");
                throw new Error("notification permission denied");
            }
            const base64 = vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/");
            const key = Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), value => value.charCodeAt(0));
            if (key.length !== 65 || key[0] !== 4)
                throw new Error("invalid WebPush VAPID public key");
            const existing = await registration.pushManager.getSubscription();
            const existingKey = existing?.options.applicationServerKey;
            if (existing && (!existingKey || new Uint8Array(existingKey).some((byte, index) => byte !== key[index]) || existingKey.byteLength !== key.length)) {
                await existing.unsubscribe();
            }
            try {
                await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
            }
            finally {
                await request("refresh");
            }
        },
        revoke: (productId) => request("revoke", productId),
        revokeAll: () => request("revokeAll"),
        refresh: () => request("refresh"),
        close() {
            for (const id of executions)
                void request("unbind", { id }).catch(() => { });
            executions.clear();
            closed = true;
            navigator.serviceWorker.removeEventListener("message", onMessage);
            window.removeEventListener("online", onOnline);
        },
    };
}

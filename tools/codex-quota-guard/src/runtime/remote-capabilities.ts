export interface RemoteCapabilities {
  remoteTui: boolean
  remoteAuthTokenEnv: boolean
  remoteUnixSocket: boolean
  remoteLoopbackWebSocket: boolean
  appServerStdio: boolean
}

export interface RemoteCapabilityHelp {
  tuiHelp: string
  appServerHelp: string
}

export function emptyRemoteCapabilities(): RemoteCapabilities {
  return {
    remoteTui: false,
    remoteAuthTokenEnv: false,
    remoteUnixSocket: false,
    remoteLoopbackWebSocket: false,
    appServerStdio: false,
  }
}

export function inspectRemoteCapabilities(help: RemoteCapabilityHelp): RemoteCapabilities {
  return {
    remoteTui: /(?:^|\s)--remote(?:\s|=|$)/m.test(help.tuiHelp),
    remoteAuthTokenEnv: /(?:^|\s)--remote-auth-token-env(?:\s|=|$)/m.test(help.tuiHelp),
    remoteUnixSocket: help.tuiHelp.includes("unix://"),
    remoteLoopbackWebSocket: help.tuiHelp.includes("ws://"),
    appServerStdio: help.appServerHelp.includes("stdio://"),
  }
}

/**
 * GENERADO — no editar a mano.
 * Fuente: packages/protocol/schemas/*.json (E1).
 * Regenerar: node sdks/javascript/generate-types.mjs
 */

/**
 * Todo mensaje del protocolo viaja dentro de este envelope. El campo payload se valida contra el esquema del type correspondiente. Un envelope con proto desconocido se rechaza sin inspeccionar el payload (D5).
 */
export type EnvelopeArena1 = {
  [k: string]: unknown;
} & {
  /**
   * Identificador de versión del protocolo. Una versión desconocida se rechaza con SHUTDOWN.
   */
  proto: "arena/1";
  type: "HELLO" | "WELCOME" | "OBSERVATION" | "COMMAND" | "EVENT" | "SHUTDOWN";
  /**
   * Tick de simulación al que se refiere el mensaje.
   */
  tick?: number;
  /**
   * Contador monótono por emisor. Detecta pérdidas y duplicados.
   */
  seq: number;
  payload: {};
};

/**
 * Primer mensaje del bot. Identifica SDK, protocolo y credencial de participación en la batalla (token emitido por bot-manager al lanzarla, ver E5.M).
 */
export interface HELLOBotMotor {
  botId: string;
  /**
   * Versión de código del bot registrada en la plataforma.
   */
  botVersion: string;
  sdk: {
    name: "arena-sdk-python" | "arena-sdk-js" | "arena-sdk-java" | "arena-sdk-dotnet" | "custom";
    version: string;
  };
  /**
   * Token de participación de un solo uso, ligado a battleId + botId. Impide que un contenedor se conecte a una batalla ajena.
   */
  battleToken: string;
  /**
   * Codificaciones que el bot admite. Reserva para la migración a binario (D5).
   *
   * @minItems 1
   */
  encodings?: ["json", ..."json"[]];
}

/**
 * Respuesta al handshake. Entrega al bot todo lo que necesita saber antes del primer tick: sus reglas, su temporización, su vehículo resuelto y el mapa que le está permitido conocer a priori.
 */
export interface WELCOMEMotorBot {
  battleId: string;
  /**
   * Identificador opaco de entidad dentro de la batalla (p. ej. veh_3, proj_a1).
   */
  selfId: string;
  team: string;
  encoding?: "json";
  /**
   * Valores efectivos de D2 para esta batalla. El bot NO debe asumir constantes: debe leerlas de aquí.
   */
  timing: {
    tickHz: number;
    decisionEveryNTicks: number;
    decisionDeadlineMs: number;
    maxConsecutiveTimeouts: number;
  };
  rules: {
    mode: "deathmatch" | "team_deathmatch" | "capture_the_flag" | "zone_control";
    rulesetId: string;
    /**
     * Presupuesto de créditos EFECTIVO de esta batalla (D7). Ajustable por ruleset/torneo como perilla de dificultad; si el ruleset no lo fija, se aplica BUDGET_CREDITS_MVP=1000. Todos los participantes de una misma competición juegan bajo el mismo valor, congelado al cerrar inscripciones.
     */
    budgetCredits?: number;
    timeLimitTicks?: number;
    scoreToWin?: number;
    friendlyFire?: boolean;
    respawn?: {
      enabled?: boolean;
      delayTicks?: number;
    };
    sharedTeamVision?: boolean;
    radio?: {
      maxMessageBytes?: number;
      maxMessagesPerSecond?: number;
      deliveryDelayDecisions?: number;
    };
  };
  /**
   * Ficha efectiva resuelta por E3 (resolveVehicle) con el catálogo congelado de la batalla.
   */
  vehicle: {
    chassis: {
      /**
       * Id versionado de una definición de módulo del catálogo (p. ej. weapon.cannon@1).
       */
      moduleId: string;
      hullHp: number;
      radiusM: number;
    };
    modules: {
      /**
       * Ranura del chasis en la que está montado el módulo.
       */
      slot: string;
      /**
       * Id versionado de una definición de módulo del catálogo (p. ej. weapon.cannon@1).
       */
      moduleId: string;
      category: "movement" | "power" | "sensor" | "weapon" | "ammo" | "mine" | "armor" | "radio" | "utility";
      /**
       * Parámetros efectivos del módulo a plena salud (rango, FOV, cadencia, daño...). Su forma depende de la categoría y la define el esquema de módulo de E3.
       */
      specs?: {
        [k: string]: unknown;
      };
    }[];
    massKg: number;
    energy: {
      capacityEU: number;
      generationEUs: number;
    };
  };
  /**
   * Metadatos del mapa y, si el ruleset lo permite, su geometría estática. La niebla de guerra (D8) NO oculta los muros fijos: oculta entidades. Un ruleset puede poner staticGeometry a false para modos de exploración a ciegas.
   */
  map: {
    mapId: string;
    mapVersion: number;
    checksum: string;
    widthM: number;
    heightM: number;
    /**
     * Muros y terreno estático, si el ruleset lo entrega. Los obstáculos destructibles y las minas NO van aquí: son entidades dinámicas y solo se perciben por sensores.
     */
    staticGeometry?: {
      [k: string]: unknown;
    };
    spawns?: {
      team: string;
      position: Vec2;
    }[];
    bases?: {
      team: string;
      position: Vec2;
    }[];
  };
  /**
   * Ids de los compañeros de equipo. Conocer quién es aliado no revela dónde está.
   */
  teammates?: string[];
  /**
   * Versiones exactas de los artefactos de esta batalla (cap. 8, 'versión fija').
   */
  versions: {
    engine: string;
    physics?: string;
    rules: string;
    catalog: string;
    protocol: "arena/1";
  };
}
/**
 * Vector 2D en metros (D1).
 */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Estado propio + detecciones autorizadas. REGLA DURA (D8): este objeto solo contiene lo que los sensores instalados y operativos del bot han percibido. Nada oculto viaja, ni siquiera marcado como oculto. Los bloques de sensor solo existen si el módulo correspondiente está instalado y en estado operational, damaged o critical.
 */
export interface OBSERVATIONMotorBot {
  /**
   * Tick de simulación al que se refiere el mensaje.
   */
  tick: number;
  self: {
    position: Vec2;
    /**
     * Ángulo en radianes, antihorario, 0 = eje +X (D1).
     */
    heading: number;
    velocity: Vec2;
    angularVelocity?: number;
    /**
     * Ángulo en radianes, antihorario, 0 = eje +X (D1).
     */
    turretHeading?: number;
    hullHp: number;
    hullHpMax?: number;
    energy: {
      storedEU: number;
      capacityEU: number;
      /**
       * Generación menos consumo actual.
       */
      netFlowEUs?: number;
    };
    /**
     * Salud restante del blindaje por sector, fracción 0..1. Solo sectores con blindaje instalado.
     */
    armor?: {
      front?: number;
      left?: number;
      right?: number;
      rear?: number;
    };
    /**
     * Estado de cada módulo instalado (cap. 12.2). El bot puede saber que se ha quedado ciego.
     */
    modules: {
      /**
       * Ranura del chasis en la que está montado el módulo.
       */
      slot: string;
      /**
       * Estados del capítulo 12.2.
       */
      state: "operational" | "damaged" | "critical" | "destroyed" | "offline";
      healthFraction?: number;
      cooldownTicks?: number;
      ammo?: number;
    }[];
    /**
     * Equipo dueño de la bandera transportada, o null.
     */
    carryingFlag?: string | null;
    respawningInTicks?: number;
  };
  /**
   * Un bloque por sensor instalado y no destruido/apagado. Ausencia de bloque = ausencia de sensor operativo.
   */
  sensors?: {
    /**
     * Un elemento por módulo lidar instalado.
     */
    lidar?: {
      /**
       * Ranura del chasis en la que está montado el módulo.
       */
      slot: string;
      /**
       * Ángulo en radianes, antihorario, 0 = eje +X (D1).
       */
      originHeading: number;
      fovRad: number;
      rays: {
        /**
         * Ángulo en radianes, antihorario, 0 = eje +X (D1).
         */
        angle: number;
        distanceM: number;
        hit: "vehicle" | "projectile" | "mine" | "wall" | "destructible" | "flag" | "base" | "zone" | "unknown";
      }[];
    }[];
    radar?: {
      /**
       * Ranura del chasis en la que está montado el módulo.
       */
      slot: string;
      /**
       * Contactos con error (D8). La posición NO es exacta y el id puede ser desconocido.
       */
      contacts: {
        /**
         * Identificador opaco de entidad dentro de la batalla (p. ej. veh_3, proj_a1).
         */
        entityId?: string;
        kind?: "vehicle" | "projectile" | "mine" | "wall" | "destructible" | "flag" | "base" | "zone" | "unknown";
        team?: string;
        position: Vec2;
        velocity?: Vec2;
        errorM: number;
        confidence?: number;
      }[];
    }[];
    proximity?: {
      /**
       * Ranura del chasis en la que está montado el módulo.
       */
      slot: string;
      triggered: boolean;
      bearings?: number[];
    }[];
    acoustic?: {
      /**
       * Ranura del chasis en la que está montado el módulo.
       */
      slot: string;
      /**
       * Solo dirección, nunca posición (cap. 11).
       */
      sources: {
        /**
         * Ángulo en radianes, antihorario, 0 = eje +X (D1).
         */
        bearing: number;
        kind: "gunshot" | "engine" | "explosion";
        intensity?: number;
      }[];
    }[];
  };
  /**
   * Mensajes de equipo entregados en este ciclo. Contenido opaco para el motor (D8).
   */
  radio?: {
    /**
     * Identificador opaco de entidad dentro de la batalla (p. ej. veh_3, proj_a1).
     */
    from: string;
    /**
     * Hasta RADIO_MAX_MESSAGE_BYTES (32) bytes en base64.
     */
    data: string;
    /**
     * Tick de simulación al que se refiere el mensaje.
     */
    sentTick?: number;
  }[];
  /**
   * Marcador público del modo de juego. No revela posiciones.
   */
  score?: {
    [k: string]: number;
  };
  /**
   * Estado público de objetivos según el modo (banderas en base o capturadas, propiedad de zonas). Una bandera transportada o caída solo aparece aquí si es información pública por ruleset; si no, hay que verla con un sensor.
   */
  objectives?: {
    kind: "flag" | "zone";
    team: string;
    state: "at_base" | "carried" | "dropped" | "returning" | "captured" | "neutral" | "contested" | "held";
    position?: Vec21;
    captureProgress?: number;
  }[];
}
/**
 * Vector 2D en metros (D1).
 */
export interface Vec2 {
  x: number;
  y: number;
}
/**
 * Vector 2D en metros (D1).
 */
export interface Vec21 {
  x: number;
  y: number;
}

/**
 * Intención del bot para el siguiente ciclo de decisión. TODOS los campos son opcionales: un COMMAND vacío es válido y significa 'sin cambios'. El motor acepta como máximo un COMMAND por ciclo (E5/T5.1); los siguientes se descartan con evento. Un comando imposible (arma destruida, sin munición, sin energía) no invalida el mensaje: se rechaza esa acción y se emite un EVENT de rejected_action.
 */
export interface COMMANDBotMotor {
  /**
   * Tick de decisión al que responde. Un comando para un tick pasado se descarta (llegó tarde).
   */
  forTick: number;
  /**
   * Intención de movimiento arcade (D3). Se traduce a velocidad objetivo según el módulo de movimiento y la masa.
   */
  move?: {
    /**
     * -1 marcha atrás a fondo, 0 parar, 1 avance a fondo.
     */
    throttle?: number;
    /**
     * -1 giro a la derecha a fondo, 1 giro a la izquierda a fondo (antihorario positivo, D1).
     */
    steer?: number;
  };
  /**
   * Objetivo de la torreta. El motor gira hacia él a la velocidad del módulo; no teletransporta el ángulo.
   */
  turret?: {
    /**
     * Ángulo absoluto deseado. Excluyente con targetPoint.
     */
    targetHeading?: number;
    targetPoint?: Vec2;
  };
  /**
   * Armas que se desea disparar este ciclo. Sujeto a cadencia, energía, munición y arco de torreta.
   *
   * @maxItems 8
   */
  fire?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  /**
   * Solicita desplegar una mina (cap. 12.3). El motor valida posición, inventario, cooldown y límites; la entidad la crea el servidor, nunca el bot.
   */
  deployMine?: {
    /**
     * Ranura del chasis en la que está montado el módulo.
     */
    slot: string;
    armDelayTicks?: number;
  };
  /**
   * Encender o apagar módulos para ahorrar energía o evitar daños (estado offline, cap. 12.2). Reactivar cuesta MODULE_REACTIVATION_TICKS.
   *
   * @maxItems 16
   */
  modules?:
    | []
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          enabled: boolean;
        }
      ];
  /**
   * Activación de utilidades (humo, reparación, jammer...). Fuera del catálogo MVP salvo las declaradas en WELCOME.
   *
   * @maxItems 8
   */
  utility?:
    | []
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          target?: Vec21;
        }
      ];
  /**
   * Mensajes de equipo a emitir. Contenido opaco. Exceder tamaño o frecuencia (D8) descarta el mensaje con evento.
   *
   * @maxItems 2
   */
  radio?:
    | []
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          /**
           * Hasta 32 bytes reales.
           */
          data: string;
          /**
           * Destinatario concreto. Ausente = difusión al equipo.
           */
          to?: string;
        }
      ]
    | [
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          /**
           * Hasta 32 bytes reales.
           */
          data: string;
          /**
           * Destinatario concreto. Ausente = difusión al equipo.
           */
          to?: string;
        },
        {
          /**
           * Ranura del chasis en la que está montado el módulo.
           */
          slot: string;
          /**
           * Hasta 32 bytes reales.
           */
          data: string;
          /**
           * Destinatario concreto. Ausente = difusión al equipo.
           */
          to?: string;
        }
      ];
  /**
   * Anotaciones del bot para las capas de depuración del visor (rutas, objetivos). El motor las ignora por completo: no afectan a la simulación y solo se conservan en replays privados.
   */
  debug?: {
    [k: string]: unknown;
  };
}
/**
 * Punto del mundo hacia el que apuntar. Excluyente con targetHeading.
 */
export interface Vec2 {
  x: number;
  y: number;
}
/**
 * Vector 2D en metros (D1).
 */
export interface Vec21 {
  x: number;
  y: number;
}

/**
 * Notificación de algo ocurrido. Un bot solo recibe eventos que le conciernen o que ha podido percibir: un impacto que sufre, una captura de su equipo, el rechazo de una acción suya. Los eventos NO son un canal alternativo de información: aplican la misma niebla de guerra (D8).
 */
export interface EVENTMotorBot {
  /**
   * Tick de simulación al que se refiere el mensaje.
   */
  tick: number;
  kind:
    | "hit_taken"
    | "hit_dealt"
    | "module_state_changed"
    | "vehicle_destroyed"
    | "respawned"
    | "mine_deployed"
    | "mine_triggered"
    | "flag_taken"
    | "flag_dropped"
    | "flag_returned"
    | "flag_captured"
    | "zone_captured"
    | "score_changed"
    | "radio_dropped"
    | "rejected_action"
    | "decision_timeout"
    | "round_ending";
  sector?: "front" | "left" | "right" | "rear";
  /**
   * Ranura del chasis en la que está montado el módulo.
   */
  slot?: string;
  /**
   * Estados del capítulo 12.2.
   */
  state?: "operational" | "damaged" | "critical" | "destroyed" | "offline";
  damage?: number;
  /**
   * Origen del evento, solo si el bot podía percibirlo. Un disparo recibido desde un enemigo no detectado NO revela su entityId.
   */
  sourceId?: string;
  /**
   * Identificador opaco de entidad dentro de la batalla (p. ej. veh_3, proj_a1).
   */
  targetId?: string;
  team?: string;
  position?: Vec2;
  score?: {
    [k: string]: number;
  };
  /**
   * Código legible para rejected_action y radio_dropped: no_ammo, no_energy, cooldown, out_of_arc, module_destroyed, invalid_position, rate_limited, too_large, no_radio, out_of_range, extra_command_discarded.
   */
  reason?: string;
  ticksRemaining?: number;
}
/**
 * Solo si la posición es pública o percibida.
 */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Cierre controlado. Es el último mensaje que recibe el bot; tras enviarlo el motor cierra la conexión. El bot dispone de gracePeriodMs para terminar (persistir aprendizaje local, cerrar ficheros) antes de que el contenedor se detenga.
 */
export interface SHUTDOWNMotorBot {
  reason:
    | "battle_finished"
    | "protocol_version_unsupported"
    | "handshake_failed"
    | "invalid_message"
    | "timeout_disqualified"
    | "disconnected"
    | "suspended"
    | "engine_error";
  /**
   * Explicación legible. Nunca contiene información privada de otros bots ni internos del motor.
   */
  detail?: string;
  /**
   * Presente solo cuando reason = battle_finished.
   */
  result?: {
    outcome?: "win" | "loss" | "draw" | "disqualified";
    score?: {
      [k: string]: number;
    };
    /**
     * Tick de simulación al que se refiere el mensaje.
     */
    ticks?: number;
  };
  gracePeriodMs?: number;
}


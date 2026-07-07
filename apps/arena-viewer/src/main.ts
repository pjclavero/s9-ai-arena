import Phaser from "phaser";
import type { ArenaSnapshot } from "@s9/protocol";
import "./style.css";

const wsUrl = import.meta.env.VITE_ARENA_WS_URL || `ws://${location.hostname}:8081/viewer`;
const status = document.querySelector<HTMLSpanElement>("#status")!;
let latest: ArenaSnapshot | undefined;

const socket = new WebSocket(wsUrl);
socket.addEventListener("open", () => (status.textContent = "Conectado"));
socket.addEventListener("close", () => (status.textContent = "Desconectado"));
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data) as ArenaSnapshot;
  if (message.type === "snapshot") latest = message;
});

class ArenaScene extends Phaser.Scene {
  private graphics!: Phaser.GameObjects.Graphics;
  private labels = new Map<string, Phaser.GameObjects.Text>();

  create(): void {
    this.graphics = this.add.graphics();
  }

  update(): void {
    if (!latest) return;
    const scaleX = this.scale.width / latest.arena.width;
    const scaleY = this.scale.height / latest.arena.height;
    const scale = Math.min(scaleX, scaleY);
    const ox = (this.scale.width - latest.arena.width * scale) / 2;
    const oy = (this.scale.height - latest.arena.height * scale) / 2;

    this.graphics.clear();
    this.graphics.lineStyle(4, 0x58616f, 1);
    this.graphics.strokeRect(ox, oy, latest.arena.width * scale, latest.arena.height * scale);

    for (const projectile of latest.projectiles) {
      this.graphics.fillStyle(0xffd166, 1);
      this.graphics.fillCircle(ox + projectile.x * scale, oy + projectile.y * scale, 4);
    }

    const liveIds = new Set<string>();
    for (const tank of latest.tanks) {
      liveIds.add(tank.id);
      const x = ox + tank.x * scale;
      const y = oy + tank.y * scale;
      const bodyColor = tank.team === "red" ? 0xef476f : 0x118ab2;
      this.graphics.fillStyle(bodyColor, tank.health > 0 ? 1 : 0.25);
      this.graphics.fillCircle(x, y, 22 * scale);
      this.graphics.lineStyle(5 * scale, 0xf5f7fa, 1);
      this.graphics.lineBetween(
        x,
        y,
        x + Math.cos(tank.turretHeading) * 34 * scale,
        y + Math.sin(tank.turretHeading) * 34 * scale,
      );
      this.graphics.fillStyle(0x222831, 1);
      this.graphics.fillRect(x - 25 * scale, y - 34 * scale, 50 * scale, 6 * scale);
      this.graphics.fillStyle(0x06d6a0, 1);
      this.graphics.fillRect(x - 25 * scale, y - 34 * scale, 50 * scale * (tank.health / 100), 6 * scale);

      let label = this.labels.get(tank.id);
      if (!label) {
        label = this.add.text(0, 0, "", { fontFamily: "Arial", fontSize: "14px", color: "#ffffff" });
        label.setOrigin(0.5, 1);
        this.labels.set(tank.id, label);
      }
      label.setText(`${tank.name} · ${tank.health}`);
      label.setPosition(x, y - 40 * scale);
    }

    for (const [id, label] of this.labels) {
      if (!liveIds.has(id)) {
        label.destroy();
        this.labels.delete(id);
      }
    }
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#10141c",
  scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
  scene: ArenaScene,
});

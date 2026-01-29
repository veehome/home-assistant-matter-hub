import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { ThermostatServer as Base } from "@matter/main/behaviors";
import { Thermostat } from "@matter/main/clusters";
import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { Temperature } from "../../utils/converters/temperature.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

import SystemMode = Thermostat.SystemMode;
import RunningMode = Thermostat.ThermostatRunningMode;

import type { ActionContext } from "@matter/main";
import { transactionIsOffline } from "../../utils/transaction-is-offline.js";

const FeaturedBase = Base.with("Heating", "Cooling", "AutoMode");

export interface ThermostatRunningState {
  heat: boolean;
  cool: boolean;
  fan: boolean;
  heatStage2: false;
  coolStage2: false;
  fanStage2: false;
  fanStage3: false;
}

export interface ThermostatServerConfig {
  supportsTemperatureRange: ValueGetter<boolean>;
  getMinTemperature: ValueGetter<Temperature | undefined>;
  getMaxTemperature: ValueGetter<Temperature | undefined>;
  getCurrentTemperature: ValueGetter<Temperature | undefined>;
  getTargetHeatingTemperature: ValueGetter<Temperature | undefined>;
  getTargetCoolingTemperature: ValueGetter<Temperature | undefined>;

  getSystemMode: ValueGetter<SystemMode>;
  getRunningMode: ValueGetter<RunningMode>;

  setSystemMode: ValueSetter<SystemMode>;
  setTargetTemperature: ValueSetter<Temperature>;
  setTargetTemperatureRange: ValueSetter<{
    low: Temperature;
    high: Temperature;
  }>;
}

export class ThermostatServerBase extends FeaturedBase {
  declare state: ThermostatServerBase.State;

  override async initialize() {
    console.log("🔧 THERMOSTAT-SERVER-CORRIGIDO: Inicializando com fix para Matter constraints v1.1");
    
    this.state.controlSequenceOfOperation =
      this.features.cooling && this.features.heating
        ? Thermostat.ControlSequenceOfOperation.CoolingAndHeating
        : this.features.cooling
        ? Thermostat.ControlSequenceOfOperation.CoolingOnly
        : Thermostat.ControlSequenceOfOperation.HeatingOnly;

    // ========== CORREÇÃO CRÍTICA ==========
    // Configurar ANTES da classe base inicializar
    // Para prevenir que @matter/node defina minSetpointDeadBand = 200
    this.state.minSetpointDeadBand = 50; // 0.5°C em centi-graus
    
    // Configurar limites que SEMPRE satisfazem: minHeat ≤ minCool - deadBand
    const deadBand = 50;
    const defaultMinTemp = 1600; // 16°C
    
    this.state.minHeatSetpointLimit = defaultMinTemp;
    this.state.minCoolSetpointLimit = defaultMinTemp + deadBand; // 16.5°C
    
    // Limites absolutos também
    this.state.absMinHeatSetpointLimit = defaultMinTemp;
    this.state.absMinCoolSetpointLimit = defaultMinTemp + deadBand;
    
    console.log(`🔧 Configurado: deadBand=${deadBand}, minHeat=${defaultMinTemp}, minCool=${defaultMinTemp + deadBand}`);
    console.log(`🔧 Verificação: ${defaultMinTemp} ≤ ${defaultMinTemp + deadBand} - ${deadBand} = SIM`);
    // ======================================
    
    await super.initialize();

    // Verificação pós-inicialização
    console.log(`🔧 Pós-inicialização: minSetpointDeadBand=${this.state.minSetpointDeadBand}`);
    console.log(`🔧 Pós-inicialização: minHeat=${this.state.minHeatSetpointLimit}, minCool=${this.state.minCoolSetpointLimit}`);

    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);

    this.reactTo(this.events.systemMode$Changed, this.systemModeChanged);
    if (this.features.cooling) {
      this.reactTo(
        this.events.occupiedCoolingSetpoint$Changed,
        this.coolingSetpointChanged,
      );
    }
    if (this.features.heating) {
      this.reactTo(
        this.events.occupiedHeatingSetpoint$Changed,
        this.heatingSetpointChanged,
      );
    }
    this.reactTo(homeAssistant.onChange, this.update);
    
    console.log("✅ ThermostatServer inicializado com correção aplicada");
  }

  private update(entity: HomeAssistantEntityInformation) {
    console.log(`🌡️  Atualizando termostato: ${entity.entity_id || 'unknown'}`);
    
    const config = this.state.config;
    const minSetpointLimit = config
      .getMinTemperature(entity.state, this.agent)
      ?.celsius(true);
    const maxSetpointLimit = config
      .getMaxTemperature(entity.state, this.agent)
      ?.celsius(true);
    const localTemperature = config
      .getCurrentTemperature(entity.state, this.agent)
      ?.celsius(true);
    const targetHeatingTemperature =
      config
        .getTargetHeatingTemperature(entity.state, this.agent)
        ?.celsius(true) ?? this.state.occupiedHeatingSetpoint;
    const targetCoolingTemperature =
      config
        .getTargetCoolingTemperature(entity.state, this.agent)
        ?.celsius(true) ?? this.state.occupiedCoolingSetpoint;

    const systemMode = this.getSystemMode(entity);
    const runningMode = config.getRunningMode(entity.state, this.agent);

    // ========== CORREÇÃO: Garantir constraints válidas ==========
    const deadBand = this.state.minSetpointDeadBand ?? 50;
    
    let minHeat = minSetpointLimit ?? this.state.minHeatSetpointLimit ?? 1600;
    let minCool = minSetpointLimit ?? this.state.minCoolSetpointLimit ?? 1600;
    
    console.log(`📐 Valores iniciais: minHeat=${minHeat}, minCool=${minCool}, deadBand=${deadBand}`);
    
    // Aplicar constraint do Matter: minHeat ≤ minCool - deadBand
    const requiredCoolMin = minHeat + deadBand;
    if (minCool < requiredCoolMin) {
      console.log(`⚙️  Ajustando minCool: ${minCool} → ${requiredCoolMin}`);
      minCool = requiredCoolMin;
    }
    
    // Verificação de segurança
    const constraintSatisfied = minHeat <= minCool - deadBand;
    if (!constraintSatisfied) {
      console.error(`❌ ERRO: Constraint não satisfeita após ajuste!`);
      console.error(`❌ ${minHeat} ≤ ${minCool} - ${deadBand} = FALSO`);
      // Forçar correção
      minCool = minHeat + deadBand;
      console.log(`⚙️  Forçando correção: minCool=${minCool}`);
    }
    
    console.log(`✅ Constraint: ${minHeat} ≤ ${minCool} - ${deadBand} = ${constraintSatisfied}`);
    // ============================================================

    applyPatchState(this.state, {
      localTemperature: localTemperature,
      systemMode: systemMode,
      thermostatRunningState: this.getRunningState(systemMode, runningMode),

      // ---- SEMPRE garantir deadBand correto ----
      minSetpointDeadBand: deadBand,

      ...(this.features.heating
        ? {
            occupiedHeatingSetpoint: targetHeatingTemperature,
            minHeatSetpointLimit: minHeat,
            maxHeatSetpointLimit: maxSetpointLimit,
            absMinHeatSetpointLimit: minHeat,
            absMaxHeatSetpointLimit: maxSetpointLimit,
          }
        : {}),

      ...(this.features.cooling
        ? {
            occupiedCoolingSetpoint: targetCoolingTemperature,
            minCoolSetpointLimit: minCool,
            maxCoolSetpointLimit: maxSetpointLimit,
            absMinCoolSetpointLimit: minCool,
            absMaxCoolSetpointLimit: maxSetpointLimit,
          }
        : {}),

      ...(this.features.autoMode
        ? {
            thermostatRunningMode: runningMode,
          }
        : {}),
    });
    
    console.log(`✅ Thermostat atualizado: heat=${minHeat/100}°C, cool=${minCool/100}°C`);
  }

  override setpointRaiseLower(request: Thermostat.SetpointRaiseLowerRequest) {
    const config = this.state.config;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const state = homeAssistant.entity.state;

    let cool = config.getTargetCoolingTemperature(state, this.agent);
    let heat = config.getTargetHeatingTemperature(state, this.agent);

    if (!heat && !cool) return;
    heat = (heat ?? cool)!;
    cool = (cool ?? heat)!;

    const adjustedCool =
      request.mode !== Thermostat.SetpointRaiseLowerMode.Heat
        ? cool.plus(request.amount / 1000, "°C")
        : cool;
    const adjustedHeat =
      request.mode !== Thermostat.SetpointRaiseLowerMode.Cool
        ? heat.plus(request.amount / 1000, "°C")
        : heat;
    this.setTemperature(adjustedHeat, adjustedCool, request.mode);
  }

  private heatingSetpointChanged(
    value: number,
    _oldValue: number,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) return;
    const next = Temperature.celsius(value / 100);
    if (!next) return;

    this.setTemperature(
      next,
      Temperature.celsius(this.state.occupiedCoolingSetpoint / 100)!,
      Thermostat.SetpointRaiseLowerMode.Heat,
    );
  }

  private coolingSetpointChanged(
    value: number,
    _oldValue: number,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) return;
    const next = Temperature.celsius(value / 100);
    if (!next) return;

    this.setTemperature(
      Temperature.celsius(this.state.occupiedHeatingSetpoint / 100)!,
      next,
      Thermostat.SetpointRaiseLowerMode.Cool,
    );
  }

  private setTemperature(
    low: Temperature,
    high: Temperature,
    mode: Thermostat.SetpointRaiseLowerMode,
  ) {
    const config = this.state.config;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);

    const supportsTemperatureRange = config.supportsTemperatureRange(
      homeAssistant.entity.state,
      this.agent,
    );

    let action: HomeAssistantAction;
    if (supportsTemperatureRange) {
      action = config.setTargetTemperatureRange({ low, high }, this.agent);
    } else {
      const both = mode === Thermostat.SetpointRaiseLowerMode.Heat ? low : high;
      action = config.setTargetTemperature(both, this.agent);
    }
    homeAssistant.callAction(action);
  }

  private systemModeChanged(
    systemMode: Thermostat.SystemMode,
    _oldValue: Thermostat.SystemMode,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) return;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(
      this.state.config.setSystemMode(systemMode, this.agent),
    );
  }

  private getSystemMode(entity: HomeAssistantEntityInformation) {
    let systemMode = this.state.config.getSystemMode(entity.state, this.agent);
    if (systemMode === Thermostat.SystemMode.Auto) {
      systemMode = this.features.autoMode
        ? SystemMode.Auto
        : this.features.heating
        ? SystemMode.Heat
        : this.features.cooling
        ? SystemMode.Cool
        : SystemMode.Sleep;
    }
    return systemMode;
  }

  private getRunningState(
    systemMode: SystemMode,
    runningMode: RunningMode,
  ): ThermostatRunningState {
    const allOff: ThermostatRunningState = {
      cool: false,
      fan: false,
      heat: false,
      heatStage2: false,
      coolStage2: false,
      fanStage2: false,
      fanStage3: false,
    };
    const heat = { ...allOff, heat: true };
    const cool = { ...allOff, cool: true };
    const dry = { ...allOff, heat: true, fan: true };
    const fanOnly = { ...allOff, fan: true };
    switch (systemMode) {
      case SystemMode.Heat:
      case SystemMode.EmergencyHeat:
        return heat;
      case SystemMode.Cool:
      case SystemMode.Precooling:
        return cool;
      case SystemMode.Dry:
        return dry;
      case SystemMode.FanOnly:
        return fanOnly;
      case SystemMode.Off:
      case SystemMode.Sleep:
        return allOff;
      case SystemMode.Auto:
        switch (runningMode) {
          case RunningMode.Heat:
            return heat;
          case RunningMode.Cool:
            return cool;
          case RunningMode.Off:
            return allOff;
        }
    }
  }
  
  // Método de segurança extra
  protected ensureConstraints(): void {
    const deadBand = this.state.minSetpointDeadBand ?? 50;
    const minHeat = this.state.minHeatSetpointLimit ?? 1600;
    const minCool = this.state.minCoolSetpointLimit ?? 1600;
    
    if (minHeat > minCool - deadBand) {
      console.warn(`⚠️  Constraints violadas, ajustando...`);
      this.state.minCoolSetpointLimit = minHeat + deadBand;
      console.log(`✅ Ajustado: minCool=${this.state.minCoolSetpointLimit}`);
    }
  }
}

export namespace ThermostatServerBase {
  export class State extends FeaturedBase.State {
    config!: ThermostatServerConfig;
  }
}

export function ThermostatServer(config: ThermostatServerConfig) {
  console.log("🏗️  Criando ThermostatServer com correção v1.1");
  return ThermostatServerBase.set({ config });
}
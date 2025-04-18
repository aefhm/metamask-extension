import {
  CHAIN_IDS,
  type PublishBatchHookRequest,
  type PublishBatchHookTransaction,
  TransactionController,
  TransactionControllerMessenger,
  TransactionMeta,
} from '@metamask/transaction-controller';
import SmartTransactionsController from '@metamask/smart-transactions-controller';
import { SmartTransactionStatuses } from '@metamask/smart-transactions-controller/dist/types';
import { Hex } from '@metamask/utils';
import {
  getCurrentChainSupportsSmartTransactions,
  getFeatureFlagsByChainId,
  getIsSmartTransaction,
  getSmartTransactionsPreferenceEnabled,
  isHardwareWallet,
} from '../../../../shared/modules/selectors';
import {
  SmartTransactionHookMessenger,
  submitSmartTransactionHook,
  submitBatchSmartTransactionHook,
} from '../../lib/transaction/smart-transactions';
import { getTransactionById } from '../../lib/transaction/util';
import { trace } from '../../../../shared/lib/trace';
///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
import {
  afterTransactionSign as afterTransactionSignMMI,
  beforeCheckPendingTransaction as beforeCheckPendingTransactionMMI,
  beforeTransactionPublish as beforeTransactionPublishMMI,
  getAdditionalSignArguments as getAdditionalSignArgumentsMMI,
} from '../../lib/transaction/mmi-hooks';
///: END:ONLY_INCLUDE_IF
import {
  handlePostTransactionBalanceUpdate,
  handleTransactionAdded,
  handleTransactionApproved,
  handleTransactionConfirmed,
  handleTransactionDropped,
  handleTransactionFailed,
  handleTransactionRejected,
  handleTransactionSubmitted,
} from '../../lib/transaction/metrics';
import {
  ControllerInitFunction,
  ControllerInitRequest,
  ControllerInitResult,
} from '../types';
import { TransactionControllerInitMessenger } from '../messengers/transaction-controller-messenger';
import { ControllerFlatState } from '../controller-list';
import { TransactionMetricsRequest } from '../../../../shared/types/metametrics';

export const TransactionControllerInit: ControllerInitFunction<
  TransactionController,
  TransactionControllerMessenger,
  TransactionControllerInitMessenger
> = (request) => {
  const {
    controllerMessenger,
    initMessenger,
    getFlatState,
    getGlobalChainId,
    getPermittedAccounts,
    getTransactionMetricsRequest,
    updateAccountBalanceForTransactionNetwork,
    persistedState,
  } = request;

  const {
    gasFeeController,
    keyringController,
    networkController,
    onboardingController,
    preferencesController,
    smartTransactionsController,
    ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
    transactionUpdateController,
    ///: END:ONLY_INCLUDE_IF
  } = getControllers(request);

  const controller: TransactionController = new TransactionController({
    enableTxParamsGasFeeUpdates: true,
    getCurrentNetworkEIP1559Compatibility: () =>
      // @ts-expect-error Controller type does not support undefined return value
      initMessenger.call('NetworkController:getEIP1559Compatibility'),
    getCurrentAccountEIP1559Compatibility: async () => true,
    // @ts-expect-error Mismatched types
    getExternalPendingTransactions: (address) =>
      getExternalPendingTransactions(smartTransactionsController(), address),
    getGasFeeEstimates: (...args) =>
      gasFeeController().fetchGasFeeEstimates(...args),
    getNetworkClientRegistry: (...args) =>
      networkController().getNetworkClientRegistry(...args),
    getNetworkState: () => networkController().state,
    // @ts-expect-error Controller type does not support undefined return value
    getPermittedAccounts,
    // @ts-expect-error Preferences controller uses Record rather than specific type
    getSavedGasFees: () => {
      const globalChainId = getGlobalChainId();
      return preferencesController().state.advancedGasFee[globalChainId];
    },
    incomingTransactions: {
      etherscanApiKeysByChainId: {
        // @ts-expect-error Controller does not support undefined values
        [CHAIN_IDS.MAINNET]: process.env.ETHERSCAN_API_KEY,
        // @ts-expect-error Controller does not support undefined values
        [CHAIN_IDS.SEPOLIA]: process.env.ETHERSCAN_API_KEY,
      },
      includeTokenTransfers: false,
      isEnabled: () =>
        preferencesController().state.useExternalServices &&
        onboardingController().state.completedOnboarding,
      queryEntireHistory: false,
      updateTransactions: false,
    },
    isFirstTimeInteractionEnabled: () =>
      preferencesController().state.securityAlertsEnabled,
    isSimulationEnabled: () =>
      preferencesController().state.useTransactionSimulations,
    messenger: controllerMessenger,
    pendingTransactions: {
      isResubmitEnabled: () => {
        const uiState = getUIState(getFlatState());
        return !(
          getSmartTransactionsPreferenceEnabled(uiState) &&
          getCurrentChainSupportsSmartTransactions(uiState)
        );
      },
    },
    publicKeyEIP7702: process.env.EIP_7702_PUBLIC_KEY as Hex | undefined,
    testGasFeeFlows: Boolean(process.env.TEST_GAS_FEE_FLOWS === 'true'),
    // @ts-expect-error Controller uses string for names rather than enum
    trace,
    hooks: {
      ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
      afterSign: (txMeta, signedEthTx) =>
        afterTransactionSignMMI(
          txMeta,
          signedEthTx,
          transactionUpdateController().addTransactionToWatchList.bind(
            transactionUpdateController(),
          ),
        ),
      beforeCheckPendingTransaction:
        beforeCheckPendingTransactionMMI.bind(this),
      beforePublish: beforeTransactionPublishMMI.bind(this),
      getAdditionalSignArguments: getAdditionalSignArgumentsMMI.bind(this),
      ///: END:ONLY_INCLUDE_IF
      // @ts-expect-error Controller type does not support undefined return value
      publish: (transactionMeta, rawTx: Hex) =>
        publishSmartTransactionHook(
          controller,
          smartTransactionsController(),
          // Init messenger cannot yet be further restricted so is a superset of what is needed
          initMessenger as SmartTransactionHookMessenger,
          getFlatState(),
          transactionMeta,
          rawTx,
        ),
      publishBatch: async (_request: PublishBatchHookRequest) =>
        await publishBatchSmartTransactionHook({
          transactionController: controller,
          smartTransactionsController: smartTransactionsController(),
          hookControllerMessenger:
            initMessenger as SmartTransactionHookMessenger,
          flatState: getFlatState(),
          transactions: _request.transactions as PublishBatchHookTransaction[],
        }),
    },
    // @ts-expect-error Keyring controller expects TxData returned but TransactionController expects TypedTransaction
    sign: (...args) => keyringController().signTransaction(...args),
    state: persistedState.TransactionController,
  });

  addTransactionControllerListeners(
    initMessenger,
    getTransactionMetricsRequest,
    updateAccountBalanceForTransactionNetwork,
  );

  const api = getApi(controller);

  return { controller, api, memStateKey: 'TxController' };
};

function getApi(
  controller: TransactionController,
): ControllerInitResult<TransactionController>['api'] {
  return {
    abortTransactionSigning:
      controller.abortTransactionSigning.bind(controller),
    getLayer1GasFee: controller.getLayer1GasFee.bind(controller),
    getTransactions: controller.getTransactions.bind(controller),
    updateAtomicBatchData: controller.updateAtomicBatchData.bind(controller),
    updateBatchTransactions:
      controller.updateBatchTransactions.bind(controller),
    updateEditableParams: controller.updateEditableParams.bind(controller),
    updatePreviousGasParams:
      controller.updatePreviousGasParams.bind(controller),
    updateSelectedGasFeeToken:
      controller.updateSelectedGasFeeToken.bind(controller),
    updateTransactionGasFees:
      controller.updateTransactionGasFees.bind(controller),
    updateTransactionSendFlowHistory:
      controller.updateTransactionSendFlowHistory.bind(controller),
  };
}

function getControllers(
  request: ControllerInitRequest<
    TransactionControllerMessenger,
    TransactionControllerInitMessenger
  >,
) {
  return {
    gasFeeController: () => request.getController('GasFeeController'),
    keyringController: () => request.getController('KeyringController'),
    networkController: () => request.getController('NetworkController'),
    onboardingController: () => request.getController('OnboardingController'),
    preferencesController: () => request.getController('PreferencesController'),
    smartTransactionsController: () =>
      request.getController('SmartTransactionsController'),
    transactionUpdateController: () =>
      request.getController('TransactionUpdateController'),
  };
}

function getSmartTransactionCommonParams(flatState: ControllerFlatState) {
  // UI state is required to support shared selectors to avoid duplicate logic in frontend and backend.
  // Ideally all backend logic would instead rely on messenger event / state subscriptions.
  const uiState = getUIState(flatState);

  // @ts-expect-error Smart transaction selector types does not match controller state
  const isSmartTransaction = getIsSmartTransaction(uiState);

  // @ts-expect-error Smart transaction selector types does not match controller state
  const featureFlags = getFeatureFlagsByChainId(uiState);

  const isHardwareWalletAccount = isHardwareWallet(uiState);

  return {
    isSmartTransaction,
    featureFlags,
    isHardwareWalletAccount,
  };
}

function publishSmartTransactionHook(
  transactionController: TransactionController,
  smartTransactionsController: SmartTransactionsController,
  hookControllerMessenger: SmartTransactionHookMessenger,
  flatState: ControllerFlatState,
  transactionMeta: TransactionMeta,
  signedTransactionInHex: Hex,
) {
  const { isSmartTransaction, featureFlags, isHardwareWalletAccount } =
    getSmartTransactionCommonParams(flatState);

  if (!isSmartTransaction) {
    // Will cause TransactionController to publish to the RPC provider as normal.
    return { transactionHash: undefined };
  }

  return submitSmartTransactionHook({
    transactionMeta,
    signedTransactionInHex,
    transactionController,
    smartTransactionsController,
    controllerMessenger: hookControllerMessenger,
    isSmartTransaction,
    isHardwareWallet: isHardwareWalletAccount,
    // @ts-expect-error Smart transaction selector return type does not match FeatureFlags type from hook
    featureFlags,
  });
}

function publishBatchSmartTransactionHook({
  transactionController,
  smartTransactionsController,
  hookControllerMessenger,
  flatState,
  transactions,
}: {
  transactionController: TransactionController;
  smartTransactionsController: SmartTransactionsController;
  hookControllerMessenger: SmartTransactionHookMessenger;
  flatState: ControllerFlatState;
  transactions: PublishBatchHookTransaction[];
}) {
  const { isSmartTransaction, featureFlags, isHardwareWalletAccount } =
    getSmartTransactionCommonParams(flatState);

  if (!isSmartTransaction) {
    // Will cause TransactionController to publish to the RPC provider as normal.
    throw new Error(
      'publishBatchSmartTransactionHook: Smart Transaction is required for batch submissions',
    );
  }

  // Get transactionMeta based on the last transaction ID
  const lastTransaction = transactions[transactions.length - 1];
  const transactionMeta = getTransactionById(
    lastTransaction.id ?? '',
    transactionController,
  );

  // If we couldn't find the transaction, we should handle that gracefully
  if (!transactionMeta) {
    throw new Error(
      `publishBatchSmartTransactionHook: Could not find transaction with id ${lastTransaction.id}`,
    );
  }

  return submitBatchSmartTransactionHook({
    transactions,
    transactionController,
    smartTransactionsController,
    controllerMessenger: hookControllerMessenger,
    isSmartTransaction,
    isHardwareWallet: isHardwareWalletAccount,
    // @ts-expect-error Smart transaction selector return type does not match FeatureFlags type from hook
    featureFlags,
    transactionMeta,
  });
}

function getExternalPendingTransactions(
  smartTransactionsController: SmartTransactionsController,
  address: string,
) {
  return smartTransactionsController.getTransactions({
    addressFrom: address,
    status: SmartTransactionStatuses.PENDING,
  });
}

function addTransactionControllerListeners(
  initMessenger: TransactionControllerInitMessenger,
  getTransactionMetricsRequest: () => TransactionMetricsRequest,
  updateAccountBalanceForTransactionNetwork: (
    transactionMeta: TransactionMeta,
  ) => void,
) {
  const transactionMetricsRequest = getTransactionMetricsRequest();

  initMessenger.subscribe(
    'TransactionController:unapprovedTransactionAdded',
    updateAccountBalanceForTransactionNetwork,
  );

  initMessenger.subscribe(
    'TransactionController:transactionConfirmed',
    updateAccountBalanceForTransactionNetwork,
  );

  initMessenger.subscribe(
    'TransactionController:postTransactionBalanceUpdated',
    handlePostTransactionBalanceUpdate.bind(null, transactionMetricsRequest),
  );

  initMessenger.subscribe(
    'TransactionController:unapprovedTransactionAdded',
    (transactionMeta) =>
      handleTransactionAdded(transactionMetricsRequest, { transactionMeta }),
  );

  initMessenger.subscribe(
    'TransactionController:transactionApproved',
    handleTransactionApproved.bind(null, transactionMetricsRequest),
  );

  initMessenger.subscribe(
    'TransactionController:transactionDropped',
    handleTransactionDropped.bind(null, transactionMetricsRequest),
  );

  initMessenger.subscribe(
    'TransactionController:transactionConfirmed',
    // @ts-expect-error Error is string in metrics code but TransactionError in TransactionMeta type from controller
    handleTransactionConfirmed.bind(null, transactionMetricsRequest),
  );

  initMessenger.subscribe(
    'TransactionController:transactionFailed',
    handleTransactionFailed.bind(null, transactionMetricsRequest),
  );

  initMessenger.subscribe(
    'TransactionController:transactionNewSwap',
    ({ transactionMeta }) =>
      // TODO: This can be called internally by the TransactionController
      // since Swaps Controller registers this action handler
      initMessenger.call('SwapsController:setTradeTxId', transactionMeta.id),
  );

  initMessenger.subscribe(
    'TransactionController:transactionNewSwapApproval',
    ({ transactionMeta }) =>
      // TODO: This can be called internally by the TransactionController
      // since Swaps Controller registers this action handler
      initMessenger.call('SwapsController:setApproveTxId', transactionMeta.id),
  );

  initMessenger.subscribe(
    'TransactionController:transactionRejected',
    handleTransactionRejected.bind(null, transactionMetricsRequest),
  );

  initMessenger.subscribe(
    'TransactionController:transactionSubmitted',
    handleTransactionSubmitted.bind(null, transactionMetricsRequest),
  );
}

function getUIState(flatState: ControllerFlatState) {
  return { metamask: flatState };
}

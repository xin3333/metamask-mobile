import React, { PureComponent } from 'react';
import { KeyringTypes } from '@metamask/keyring-controller';
import Engine from '../../../core/Engine';
import PropTypes from 'prop-types';
import {
  Alert,
  ActivityIndicator,
  InteractionManager,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Text,
  View,
  SafeAreaView,
  Platform,
} from 'react-native';
import { fontStyles } from '../../../styles/common';
import Device from '../../../util/device';
import { strings } from '../../../../locales/i18n';
import { toChecksumAddress } from 'ethereumjs-util';
import Logger from '../../../util/Logger';
import Analytics from '../../../core/Analytics/Analytics';
import { MetaMetricsEvents } from '../../../core/Analytics';
import AnalyticsV2 from '../../../util/analyticsV2';
import { doENSReverseLookup } from '../../../util/ENSUtils';
import AccountElement from './AccountElement';
import { connect } from 'react-redux';
import { ThemeContext, mockTheme } from '../../../util/theme';
import { safeToChecksumAddress } from '../../../util/address';
import generateTestId from '../../../../wdio/utils/generateTestId';
import {
  ACCOUNT_LIST_ID,
  CREATE_ACCOUNT_BUTTON_ID,
  IMPORT_ACCOUNT_BUTTON_ID,
} from '../../../../wdio/screen-objects/testIDs/Components/AccountListComponent.testIds';

const createStyles = (colors) =>
  StyleSheet.create({
    wrapper: {
      backgroundColor: colors.background.default,
      borderTopLeftRadius: 10,
      borderTopRightRadius: 10,
      minHeight: 450,
    },
    titleWrapper: {
      width: '100%',
      height: 33,
      alignItems: 'center',
      justifyContent: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.muted,
    },
    dragger: {
      width: 48,
      height: 5,
      borderRadius: 4,
      backgroundColor: colors.border.default,
      opacity: Device.isAndroid() ? 0.6 : 0.5,
    },
    accountsWrapper: {
      flex: 1,
    },
    footer: {
      height: Device.isIphoneX() ? 200 : 170,
      paddingBottom: Device.isIphoneX() ? 30 : 0,
      justifyContent: 'center',
      flexDirection: 'column',
      alignItems: 'center',
    },
    btnText: {
      fontSize: 14,
      color: colors.primary.default,
      ...fontStyles.normal,
    },
    footerButton: {
      width: '100%',
      height: 55,
      alignItems: 'center',
      justifyContent: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.muted,
    },
  });

/**
 * View that contains the list of all the available accounts
 */
class AccountList extends PureComponent {
  static propTypes = {
    /**
     * Map of accounts to information objects including balances
     */
    accounts: PropTypes.object,
    /**
     * An object containing each identity in the format address => account
     */
    identities: PropTypes.object,
    /**
     * A string representing the selected address => account
     */
    selectedAddress: PropTypes.string,
    /**
     * An object containing all the keyrings
     */
    keyrings: PropTypes.array,
    /**
     * function to be called when switching accounts
     */
    onAccountChange: PropTypes.func,
    /**
     * function to be called when importing an account
     */
    onImportAccount: PropTypes.func,
    /**
     * function to be called when connect to a QR hardware
     */
    onConnectHardware: PropTypes.func,
    /**
     * Current provider ticker
     */
    ticker: PropTypes.string,
    /**
     * Whether it will show options to create or import accounts
     */
    enableAccountsAddition: PropTypes.bool,
    /**
     * function to generate an error string based on a passed balance
     */
    getBalanceError: PropTypes.func,
    /**
     * Indicates whether third party API mode is enabled
     */
    thirdPartyApiMode: PropTypes.bool,
    /**
     * ID of the current network
     */
    network: PropTypes.string,
  };

  state = {
    loading: false,
    orderedAccounts: {},
    accountsENS: {},
  };

  flatList = React.createRef();
  lastPosition = 0;
  updating = false;

  componentDidMount() {
    this.mounted = true;
    const orderedAccounts = this.getAccounts();
    InteractionManager.runAfterInteractions(() => {
      this.assignENSToAccounts(orderedAccounts);
      if (orderedAccounts.length > 4) {
        const selectedAccountIndex =
          orderedAccounts.findIndex((account) => account.isSelected) || 0;
        this.scrollToCurrentAccount(selectedAccountIndex);
      }
    });
    this.mounted && this.setState({ orderedAccounts });
  }

  componentWillUnmount = () => {
    this.mounted = false;
  };

  scrollToCurrentAccount(selectedAccountIndex) {
    // eslint-disable-next-line no-unused-expressions
    this.flatList?.current?.scrollToIndex({
      index: selectedAccountIndex,
      animated: true,
    });
  }

  onAccountChange = async (newAddress) => {
    const { PreferencesController } = Engine.context;
    const { accounts } = this.props;

    requestAnimationFrame(async () => {
      try {
        // If not enabled is used from address book so we don't change accounts
        if (!this.props.enableAccountsAddition) {
          this.props.onAccountChange(newAddress);
          const orderedAccounts = this.getAccounts();
          this.mounted && this.setState({ orderedAccounts });
          return;
        }

        PreferencesController.setSelectedAddress(newAddress);

        this.props.onAccountChange();

        this.props.thirdPartyApiMode &&
          InteractionManager.runAfterInteractions(async () => {
            setTimeout(() => {
              Engine.refreshTransactionHistory();
            }, 1000);
          });
      } catch (e) {
        Logger.error(e, 'error while trying change the selected account'); // eslint-disable-line
      }
      InteractionManager.runAfterInteractions(() => {
        setTimeout(() => {
          // Track Event: "Switched Account"
          AnalyticsV2.trackEvent(MetaMetricsEvents.SWITCHED_ACCOUNT, {
            number_of_accounts: Object.keys(accounts ?? {}).length,
          });
        }, 1000);
      });
      const orderedAccounts = this.getAccounts();
      this.mounted && this.setState({ orderedAccounts });
    });
  };

  importAccount = () => {
    this.props.onImportAccount();
    InteractionManager.runAfterInteractions(() => {
      Analytics.trackEvent(MetaMetricsEvents.ACCOUNTS_IMPORTED_NEW_ACCOUNT);
    });
  };

  connectHardware = () => {
    this.props.onConnectHardware();
    AnalyticsV2.trackEvent(MetaMetricsEvents.CONNECT_HARDWARE_WALLET);
  };

  addAccount = async () => {
    if (this.state.loading) return;
    this.mounted && this.setState({ loading: true });
    const { KeyringController, PreferencesController } = Engine.context;
    requestAnimationFrame(async () => {
      try {
        const { addedAccountAddress } = await KeyringController.addNewAccount();
        const checksummedAddress = safeToChecksumAddress(addedAccountAddress);
        PreferencesController.setSelectedAddress(checksummedAddress);
        setTimeout(() => {
          this.flatList &&
            this.flatList.current &&
            this.flatList.current.scrollToEnd();
          this.mounted && this.setState({ loading: false });
        }, 500);
        // Use setTimeout to ensure latest accounts are reflected in the next frame
        setTimeout(() => {
          const orderedAccounts = this.getAccounts();
          this.mounted && this.setState({ orderedAccounts });
        }, 0);
      } catch (e) {
        // Restore to the previous index in case anything goes wrong
        Logger.error(e, 'error while trying to add a new account'); // eslint-disable-line
        this.mounted && this.setState({ loading: false });
      }
    });
    InteractionManager.runAfterInteractions(() => {
      Analytics.trackEvent(MetaMetricsEvents.ACCOUNTS_ADDED_NEW_ACCOUNT);
    });
  };

  isImported(allKeyrings, address) {
    let ret = false;
    for (const keyring of allKeyrings) {
      if (keyring.accounts.includes(address)) {
        ret = keyring.type === KeyringTypes.simple;
        break;
      }
    }

    return ret;
  }

  isQRHardware(allKeyrings, address) {
    let ret = false;
    for (const keyring of allKeyrings) {
      if (keyring.accounts.includes(address)) {
        ret = keyring.type === KeyringTypes.qr;
        break;
      }
    }

    return ret;
  }

  onLongPress = (address, imported, index) => {
    if (!imported) return;
    Alert.alert(
      strings('accounts.remove_account_title'),
      strings('accounts.remove_account_message'),
      [
        {
          text: strings('accounts.no'),
          onPress: () => false,
          style: 'cancel',
        },
        {
          text: strings('accounts.yes_remove_it'),
          onPress: async () => {
            const { PreferencesController } = Engine.context;
            const { selectedAddress } = this.props;
            const isRemovingCurrentAddress = selectedAddress === address;
            const fallbackAccountIndex = index - 1;
            const fallbackAccountAddress =
              this.state.orderedAccounts[fallbackAccountIndex].address;

            // TODO - Refactor logic. onAccountChange is only used for refreshing latest orderedAccounts after account removal. Duplicate call for PreferencesController.setSelectedAddress exists.
            // Set fallback address before removing account if removing current account
            isRemovingCurrentAddress &&
              PreferencesController.setSelectedAddress(fallbackAccountAddress);
            await Engine.context.KeyringController.removeAccount(address);
            // Default to the previous account in the list if removing current account
            this.onAccountChange(
              isRemovingCurrentAddress
                ? fallbackAccountAddress
                : selectedAddress,
            );
          },
        },
      ],
      { cancelable: false },
    );
  };

  renderItem = ({ item }) => {
    const { ticker } = this.props;
    const { accountsENS } = this.state;
    return (
      <AccountElement
        onPress={this.onAccountChange}
        onLongPress={this.onLongPress}
        item={{ ...item, ens: accountsENS[item.address] }}
        ticker={ticker}
        disabled={Boolean(item.balanceError)}
      />
    );
  };

  getAccounts() {
    const { accounts, identities, selectedAddress, keyrings, getBalanceError } =
      this.props;
    // This is a temporary fix until we can read the state from @metamask/keyring-controller
    const allKeyrings =
      keyrings && keyrings.length
        ? keyrings
        : Engine.context.KeyringController.state.keyrings;

    const accountsOrdered = allKeyrings.reduce(
      (list, keyring) => list.concat(keyring.accounts),
      [],
    );
    return accountsOrdered
      .filter((address) => !!identities[toChecksumAddress(address)])
      .map((addr, index) => {
        const checksummedAddress = toChecksumAddress(addr);
        const identity = identities[checksummedAddress];
        const { name, address } = identity;
        const identityAddressChecksummed = toChecksumAddress(address);
        const isSelected = identityAddressChecksummed === selectedAddress;
        const isImported = this.isImported(
          allKeyrings,
          identityAddressChecksummed,
        );
        const isQRHardware = this.isQRHardware(
          allKeyrings,
          identityAddressChecksummed,
        );
        let balance = 0x0;
        if (accounts[identityAddressChecksummed]) {
          balance = accounts[identityAddressChecksummed].balance;
        }

        const balanceError = getBalanceError ? getBalanceError(balance) : null;
        return {
          index,
          name,
          address: identityAddressChecksummed,
          balance,
          isSelected,
          isImported,
          isQRHardware,
          balanceError,
        };
      });
  }

  assignENSToAccounts = (orderedAccounts) => {
    const { network } = this.props;
    orderedAccounts.forEach(async (account) => {
      try {
        const ens = await doENSReverseLookup(account.address, network);
        this.setState((state) => ({
          accountsENS: {
            ...state.accountsENS,
            [account.address]: ens,
          },
        }));
      } catch {
        // Error
      }
    });
  };

  keyExtractor = (item) => item.address;

  render() {
    const { orderedAccounts } = this.state;
    const { enableAccountsAddition } = this.props;
    const colors = this.context.colors || mockTheme.colors;
    const styles = createStyles(colors);

    return (
      <SafeAreaView
        style={styles.wrapper}
        {...generateTestId(Platform, ACCOUNT_LIST_ID)}
      >
        <View style={styles.titleWrapper}>
          <View style={styles.dragger} testID={'account-list-dragger'} />
        </View>
        <FlatList
          data={orderedAccounts}
          keyExtractor={this.keyExtractor}
          renderItem={this.renderItem}
          ref={this.flatList}
          style={styles.accountsWrapper}
          testID={'account-number-button'}
          getItemLayout={(_, index) => ({
            length: 80,
            offset: 80 * index,
            index,
          })} // eslint-disable-line
        />
        {enableAccountsAddition && (
          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.footerButton}
              {...generateTestId(Platform, CREATE_ACCOUNT_BUTTON_ID)}
              onPress={this.addAccount}
            >
              {this.state.loading ? (
                <ActivityIndicator
                  size="small"
                  color={colors.primary.default}
                />
              ) : (
                <Text style={styles.btnText}>
                  {strings('accounts.create_new_account')}
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={this.importAccount}
              style={styles.footerButton}
              {...generateTestId(Platform, IMPORT_ACCOUNT_BUTTON_ID)}
            >
              <Text style={styles.btnText}>
                {strings('accounts.import_account')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={this.connectHardware}
              style={styles.footerButton}
              testID={'connect-hardware'}
            >
              <Text style={styles.btnText}>
                {strings('accounts.connect_hardware')}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>
    );
  }
}

AccountList.contextType = ThemeContext;

const mapStateToProps = (state) => ({
  accounts: state.engine.backgroundState.AccountTrackerController.accounts,
  thirdPartyApiMode: state.privacy.thirdPartyApiMode,
  keyrings: state.engine.backgroundState.KeyringController.keyrings,
  network: state.engine.backgroundState.NetworkController.network,
});

export default connect(mapStateToProps)(AccountList);
